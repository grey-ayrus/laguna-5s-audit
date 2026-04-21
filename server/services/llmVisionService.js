/**
 * Online-vision scoring for the Laguna 5S engine.
 *
 * The auditor supplies a live capture of a factory zone. For every zone we
 * also keep a "standard" reference photo (showing what the zone should look
 * like when it is in full 5S compliance). We send BOTH images to a
 * vision-capable LLM and ask it to score the capture's *deviation* from the
 * reference on each of the 5 S's, on a 1..36 scale.
 *
 *   score_S         = integer in [1, 36]   (1 = complete failure, 36 = identical to reference)
 *   total           = sort + setInOrder + shine + standardize + sustain    (5..180)
 *   totalFinal      = total / (180 * imageCount) * 10  (0.00..10.00)
 *   status          = 'Green' >= 8.00  'Yellow' >= 5.00  'Red' < 5.00   (based on totalFinal)
 *
 * For each capture we do two independent LLM passes (strict auditor +
 * adversarial skeptic) and merge them. When the two disagree meaningfully
 * we favour the harsher score - this stops a single overly generous call
 * from handing out a 34/36 to a cluttered fabric rack.
 */

import axios from 'axios';
import { resolveZone } from '../config/zones.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const S_KEYS = ['sort', 'setInOrder', 'shine', 'standardize', 'sustain'];
const S_LABELS = {
  sort: 'Sort (Seiri)',
  setInOrder: 'Set in Order (Seiton)',
  shine: 'Shine (Seiso)',
  standardize: 'Standardize (Seiketsu)',
  sustain: 'Sustain (Shitsuke)',
};

const SCORE_MAX_PER_S = 36;
const SCORE_MAX_TOTAL = SCORE_MAX_PER_S * S_KEYS.length; // 180

// Two complementary system prompts. Same scoring rubric, different bias.
const SYSTEM_PROMPT_STRICT = [
  'You are the HEAD 5S auditor for a garment manufacturing plant in India, known for being harsh but fair.',
  'For every audit you are given TWO photos:',
  '  Image #1 (the "reference") shows what the zone SHOULD look like when 5S compliance is perfect.',
  '  Image #2 onwards are today\'s CAPTURES of the real zone - score these.',
  '',
  'Your job is to measure how far each capture DEVIATES from the reference.',
  'Score each of Sort, Set in Order, Shine, Standardize, Sustain on an INTEGER scale of 1..36 using this rubric:',
  '  33-36 = capture is essentially indistinguishable from the reference on this S. Rare.',
  '  25-32 = very close to reference; 1-2 minor deviations.',
  '  17-24 = clearly below reference; 3-5 visible problems.',
  '   9-16 = many visible problems; roughly half the elements from the reference are missing or wrong.',
  '   1-8  = failing; capture looks nothing like the reference for this S, OR a critical safety / contamination issue is present.',
  '',
  'Anti-flattery rules (VIOLATION = wrong answer):',
  '  - Do NOT give any S above 30 unless the capture genuinely matches the reference.',
  '  - Do NOT default to 25 or higher to be polite. When in doubt, score 15-20.',
  '  - If you scored any S below 25, you MUST list at least 2 concrete issues for that S (not vague text).',
  '  - A final totalFinal of 8.0/10 or above is ONLY justified when every S is independently at reference quality.',
  '',
  'Issue rules:',
  '  - Return between 4 and 10 total issues per audit (unless every S >= 33).',
  '  - Each issue MUST name a specific observable object or location in the CAPTURE image',
  '    ("red bucket left on walkway near sewing machine 3", NOT "clutter present").',
  '  - Severity: "critical" for safety/contamination, "moderate" for workflow impact, "minor" for cosmetic.',
  '',
  'Return STRICT JSON only, no Markdown, no prose outside the JSON.',
].join('\n');

const SYSTEM_PROMPT_SKEPTIC = [
  'You are an ADVERSARIAL 5S auditor whose job is to find problems other auditors missed.',
  'You are given a REFERENCE photo (image #1) that shows the zone in perfect 5S condition,',
  'and one or more CAPTURE photos (image #2 onwards) of the real zone today.',
  'Assume the captures are hiding problems. Specifically look for things PRESENT in the capture',
  'that are ABSENT from the reference, and vice-versa:',
  '  - Items that appear on floor, walkways, or on top of other items but not in reference',
  '  - Tools, fabric, bins stored outside the positions shown in the reference',
  '  - Missing visual controls that ARE in the reference: labels, floor lines, shadow boards, SOP charts',
  '  - Dust, oil, lint, thread scraps, fabric offcuts on floor or surfaces',
  '  - Safety concerns: blocked walkways, missing PPE, exposed wiring, unsafe stacking',
  '  - Sustain failures: torn signage, bent partitions, faded markings compared to reference',
  '',
  'Score on the same 1..36 per-S rubric, but bias toward the LOWER score when judgement is ambiguous.',
  'A score above 30 should be genuinely rare and only when the capture clearly matches the reference.',
  'Return STRICT JSON only, matching the schema.',
].join('\n');

function buildUserPrompt(zone, history, hasReference) {
  const rules = [
    `Zone: ${zone.code} - ${zone.name} (${zone.category}).`,
    `Allowed items (do not flag for Sort): ${(zone.allowedItems || []).join(', ') || 'none'}.`,
    `Must-have items (missing = Standardize/Sustain penalty): ${(zone.mustHave || []).join(', ') || 'none'}.`,
    `Forbidden items (always flag for Sort, severity critical): ${(zone.forbidden || []).join(', ') || 'none'}.`,
    `Clutter limit (occupied floor ratio before Sort penalty): ${zone.clutterLimit ?? 0.2}.`,
  ].join('\n');

  const historySummary = (history || []).slice(0, 3).map((h, i) => {
    const final = h.scores?.totalFinal != null ? `${h.scores.totalFinal.toFixed(2)}/10` : (h.scores ? `total=${h.scores.total}/${SCORE_MAX_TOTAL}` : '');
    const count = (h.issues || []).length;
    return `  #${i + 1} ${final}, ${count} issue(s) previously`;
  }).join('\n');

  const firstImageNote = hasReference
    ? 'IMAGE ORDERING: image #1 is the REFERENCE ("standard") photo - do NOT score it. Image #2 onwards are CAPTURES to score.'
    : 'IMAGE ORDERING: there is NO reference image for this zone. Score the captures on their own merits using the rubric.';

  const schema = `Schema (return exactly this JSON, no Markdown, no comments):
{
  "scores": { "sort": 1-36, "setInOrder": 1-36, "shine": 1-36, "standardize": 1-36, "sustain": 1-36 },
  "issues": [
    { "s": "sort|setInOrder|shine|standardize|sustain",
      "tag": "snake_case_code",
      "label": "Specific observation naming the object and its location in the capture",
      "severity": "minor|moderate|critical",
      "image_index": 0 }
  ],
  "actionPoints": ["imperative verb phrase 1", "imperative verb phrase 2", "..."],
  "summary": "3-4 sentences. Call out the biggest deviations from the reference first, not the positives.",
  "remarks": "1 sentence: what the supervisor must tell the team at the next toolbox talk."
}`;

  return [
    firstImageNote,
    '5S rules specific to this zone:',
    rules,
    historySummary ? `Previous audits (most recent first):\n${historySummary}` : 'No prior audits on record for this zone.',
    'Scoring self-check (answer silently before writing JSON, then write JSON):',
    '  1. For each S I scored >= 30, can I point to exact reference features that are preserved in the capture?',
    '  2. Is any S >= 33 really indistinguishable from the reference, or am I being generous?',
    '  3. Did I find at least 4 specific issues across the captures? If not, I am probably missing things.',
    '  4. Did my summary LEAD with the biggest deviation, not a compliment?',
    schema,
    'Mandatory counts:',
    '  - If any S is below 30: issues array MUST have 4 or more entries.',
    '  - actionPoints MUST have 3 or more entries unless every S >= 33.',
    '  - image_index is 0-based and refers to CAPTURE images only (reference is not indexed).',
    'No Markdown. No code fences. No keys other than the ones above. Output JSON only.',
  ].join('\n\n');
}

function toDataUrl(dataUrlOrBase64) {
  if (!dataUrlOrBase64) return null;
  return dataUrlOrBase64.startsWith('data:')
    ? dataUrlOrBase64
    : `data:image/jpeg;base64,${dataUrlOrBase64}`;
}

function buildMessages(zone, captureImages, referenceImage, history, variant = 'strict') {
  const content = [{ type: 'text', text: buildUserPrompt(zone, history, Boolean(referenceImage)) }];
  if (referenceImage) {
    content.push({ type: 'text', text: 'Image #1 below is the REFERENCE for this zone.' });
    content.push({ type: 'image_url', image_url: { url: toDataUrl(referenceImage) } });
    content.push({ type: 'text', text: 'The images below are the CAPTURES to score.' });
  }
  for (const dataUrl of captureImages) {
    content.push({ type: 'image_url', image_url: { url: toDataUrl(dataUrl) } });
  }
  const system = variant === 'skeptic' ? SYSTEM_PROMPT_SKEPTIC : SYSTEM_PROMPT_STRICT;
  return [
    { role: 'system', content: system },
    { role: 'user', content },
  ];
}

function pickKey(provider, explicitKey) {
  const env = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY;
  return (explicitKey && explicitKey.trim()) || (env && env.trim()) || '';
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(candidate.slice(first, last + 1)); } catch (_) { /* noop */ }
    }
    return null;
  }
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return Math.round(SCORE_MAX_PER_S / 2);
  return Math.min(SCORE_MAX_PER_S, Math.max(1, v));
}

function finalScore(total, imageCount) {
  const images = Math.max(1, Number(imageCount) || 1);
  const raw = total / (SCORE_MAX_TOTAL * images) * 10;
  return Math.round(raw * 100) / 100;
}

function statusForFinal(totalFinal) {
  if (totalFinal >= 8.0) return 'Green';
  if (totalFinal >= 5.0) return 'Yellow';
  return 'Red';
}

function normalise(raw, zone, imageCount) {
  const scores = {};
  for (const s of S_KEYS) scores[s] = clampScore(raw?.scores?.[s]);
  scores.total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  scores.imageCount = imageCount;
  scores.totalFinal = finalScore(scores.total, imageCount);

  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  const cleanedIssues = issues
    .filter((i) => i && S_KEYS.includes(i.s))
    .map((i) => ({
      s: i.s,
      tag: String(i.tag || i.label || 'issue').slice(0, 60),
      label: String(i.label || i.tag || 'Issue detected').slice(0, 240),
      severity: ['minor', 'moderate', 'critical'].includes(i.severity) ? i.severity : 'moderate',
      image_index: Math.min(
        Math.max(Number.isFinite(+i.image_index) ? +i.image_index : 0, 0),
        Math.max(imageCount - 1, 0),
      ),
    }));

  const issuesByS = S_KEYS.reduce((acc, s) => {
    acc[s] = cleanedIssues.filter((i) => i.s === s).map((i) => i.label);
    return acc;
  }, {});

  const actionPoints = Array.isArray(raw?.actionPoints)
    ? raw.actionPoints.map((a) => String(a)).filter(Boolean).slice(0, 8)
    : [];

  return {
    zone: { id: zone.id, code: zone.code, name: zone.name, category: zone.category },
    scores,
    status: statusForFinal(scores.totalFinal),
    issues: cleanedIssues,
    issuesByS,
    actionPoints: actionPoints.length
      ? actionPoints
      : [`Review ${S_LABELS.sort.toLowerCase()} and ${S_LABELS.shine.toLowerCase()} findings and assign owners.`],
    summary: String(raw?.summary || `${zone.code} ${zone.name}: online vision scored ${scores.totalFinal.toFixed(2)}/10.00 with ${cleanedIssues.length} issue(s).`),
    remarks: String(raw?.remarks || 'Audit evaluated by an online vision model; verify critical findings on the floor.'),
    annotations: [],
    annotatedImages: [],
  };
}

async function callOpenAICompatible({ url, apiKey, model, messages, temperature = 0.2 }) {
  const res = await axios.post(url, {
    model,
    messages,
    temperature,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  }, {
    timeout: 90_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const text = res.data?.choices?.[0]?.message?.content;
  return { text, usage: res.data?.usage };
}

function issueKey(issue) {
  return `${issue.s}|${String(issue.label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;
}

// Penalty step per S when we escalate for under-counting.
const PENALTY_STEP = 4;

function mergeResults(a, b, zone, imageCount) {
  const scores = {};
  for (const s of S_KEYS) {
    const sa = clampScore(a.scores[s]);
    const sb = clampScore(b.scores[s]);
    const mean = (sa + sb) / 2;
    // If the two passes disagree by more than 8 points (out of 36), trust the harsher pass.
    const gap = Math.abs(sa - sb);
    scores[s] = gap >= 8 ? Math.min(sa, sb) : Math.round(mean);
    scores[s] = clampScore(scores[s]);
  }

  const seen = new Map();
  for (const src of [a.issues, b.issues]) {
    for (const issue of src || []) {
      const key = issueKey(issue);
      if (!seen.has(key)) {
        seen.set(key, issue);
      } else {
        const prev = seen.get(key);
        const rank = { minor: 0, moderate: 1, critical: 2 };
        if ((rank[issue.severity] || 0) > (rank[prev.severity] || 0)) {
          seen.set(key, issue);
        }
      }
    }
  }
  const issues = Array.from(seen.values());

  // Under-count guardrail: if any S is below ~25/36 but we have fewer than
  // 4 issues, penalise the two weakest S's - the model is under-reporting.
  const worstS = Math.min(...S_KEYS.map((s) => scores[s]));
  if (worstS < 25 && issues.length < 4) {
    const ranked = [...S_KEYS].sort((x, y) => scores[x] - scores[y]);
    for (const s of ranked.slice(0, Math.max(0, 4 - issues.length))) {
      scores[s] = clampScore(scores[s] - PENALTY_STEP);
    }
  }

  // If the model claimed near-perfect but also flagged real issues, pull it down.
  let total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  if (total >= 170 && issues.length >= 2) {
    scores.setInOrder = clampScore(scores.setInOrder - PENALTY_STEP);
  }

  scores.total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  scores.imageCount = imageCount;
  scores.totalFinal = finalScore(scores.total, imageCount);

  const issuesByS = S_KEYS.reduce((acc, s) => {
    acc[s] = issues.filter((i) => i.s === s).map((i) => i.label);
    return acc;
  }, {});

  const pickSummary = (x, y) => {
    const looksFlat = (t) => /^\s*(the area|this zone|overall)\s+(appears|looks|is well|is very)/i.test(t || '');
    if (looksFlat(x) && !looksFlat(y)) return y;
    return x || y || '';
  };

  const actionPoints = Array.from(new Set([...(a.actionPoints || []), ...(b.actionPoints || [])]))
    .filter(Boolean)
    .slice(0, 8);

  return {
    zone: { id: zone.id, code: zone.code, name: zone.name, category: zone.category },
    scores,
    status: statusForFinal(scores.totalFinal),
    issues,
    issuesByS,
    actionPoints: actionPoints.length ? actionPoints : [
      `Walk the zone again and document Sort and Shine findings with photos.`,
      `Assign owners for the open items and re-audit within one week.`,
    ],
    summary: pickSummary(a.summary, b.summary)
      || `${zone.code} ${zone.name}: consensus score ${scores.totalFinal.toFixed(2)}/10.00 with ${issues.length} issue(s) across two independent passes.`,
    remarks: a.remarks || b.remarks || 'Audit evaluated by two independent vision passes; please verify critical findings on the floor.',
    annotations: [],
    annotatedImages: [],
  };
}

/**
 * Dual-pass consensus scoring that optionally includes a reference image.
 *
 * @param {string} zoneId
 * @param {string[]} imagesBase64     Capture images (data URL or raw base64).
 * @param {string} [referenceImage]   Reference/standard image (data URL or raw base64), or null.
 * @param {object[]} history
 * @param {string} provider
 * @param {string} model
 * @param {string} apiKey
 */
export async function scoreWithLLM({ zoneId, imagesBase64, referenceImage, history, provider, model, apiKey }) {
  const zone = resolveZone(zoneId);
  if (!zone) throw new Error(`Unknown zone: ${zoneId}`);

  const key = pickKey(provider, apiKey);
  if (!key) {
    throw new Error(`No API key available for provider "${provider}". Save one in Settings or set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY'} in .env.`);
  }

  const url = provider === 'openai' ? OPENAI_URL : GROQ_URL;

  const runPass = async (variant, temperature) => {
    const messages = buildMessages(zone, imagesBase64, referenceImage, history, variant);
    const { text } = await callOpenAICompatible({ url, apiKey: key, model, messages, temperature });
    const parsed = extractJson(text);
    if (!parsed) throw new Error(`LLM (${variant}) returned invalid JSON`);
    return normalise(parsed, zone, imagesBase64.length);
  };

  const [strictSettled, skepticSettled] = await Promise.allSettled([
    runPass('strict', 0.15),
    runPass('skeptic', 0.35),
  ]);

  const strict = strictSettled.status === 'fulfilled' ? strictSettled.value : null;
  const skeptic = skepticSettled.status === 'fulfilled' ? skepticSettled.value : null;

  if (!strict && !skeptic) {
    const err = strictSettled.reason || skepticSettled.reason;
    throw new Error(`Both LLM passes failed: ${err?.message || err}`);
  }
  if (strict && !skeptic) return strict;
  if (!strict && skeptic) return skeptic;
  return mergeResults(strict, skeptic, zone, imagesBase64.length);
}

export async function pingLLM({ provider, model, apiKey }) {
  const key = pickKey(provider, apiKey);
  if (!key) throw new Error('No API key provided and no server-side fallback is configured.');

  const url = provider === 'openai' ? OPENAI_URL : GROQ_URL;
  const started = Date.now();
  const res = await axios.post(url, {
    model,
    messages: [
      { role: 'system', content: 'Reply with the single word OK.' },
      { role: 'user', content: 'ping' },
    ],
    max_tokens: 3,
    temperature: 0,
  }, {
    timeout: 15_000,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });
  const latencyMs = Date.now() - started;
  const reply = res.data?.choices?.[0]?.message?.content || '';
  return { ok: true, latencyMs, reply: String(reply).slice(0, 40) };
}

export function isOnlineProvider(provider) {
  return provider === 'openai' || provider === 'groq';
}

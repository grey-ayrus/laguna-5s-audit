/**
 * Optional online-vision fallback for the Laguna 5S engine.
 *
 * When the UI asks for `aiProvider === 'openai' | 'groq'`, this module takes
 * the same inputs the Python engine would have seen (zone + base64 images +
 * prior-audit summary) and asks a vision-capable LLM to score the scene. The
 * response is normalised into the exact shape the rest of the server expects
 * (scores, issues, actionPoints, summary, status, annotations, remarks) so
 * the controller can treat it interchangeably with the Python engine output.
 *
 * We never persist API keys on the server: the key comes from the request
 * body (user's localStorage) and falls back to `process.env.OPENAI_API_KEY`
 * / `process.env.GROQ_API_KEY` only if the admin has set one in `.env`.
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

// Two complementary system prompts. We run the LLM twice with slightly
// different framings and combine the results for a steadier, harsher score.
const SYSTEM_PROMPT_STRICT = [
  'You are the HEAD 5S auditor for a garment manufacturing plant in India, known for being harsh but fair.',
  'Typical Indian factory zones have DOZENS of real 5S problems. If your first reaction is "this looks fine",',
  'you are wrong - look again more carefully. The plant manager loses respect for auditors who hand out easy scores.',
  '',
  'Score each of Sort, Set in Order, Shine, Standardize, Sustain as an integer 1..4 using this STRICT rubric:',
  '  4 = exemplary; zero visible deviations from 5S; benchmark-worthy. Very rare in practice.',
  '  3 = acceptable; 1-2 minor deviations only; clearly trained team.',
  '  2 = below target; 3-5 visible problems; obvious rework needed.',
  '  1 = failing; 6+ problems or any critical safety / contamination issue.',
  '',
  'Anti-flattery rules (VIOLATION = wrong answer):',
  '  - Do NOT write phrases like "looks clean", "well-maintained", "appears organized" unless the score is 4.',
  '  - Do NOT default to 3 or 4 to be polite. When in doubt, score 2.',
  '  - If you scored any S as 3 or lower, you MUST list at least 2 concrete issues for that S (not vague text).',
  '  - Total of 17+ is ONLY justified when every S is independently excellent.',
  '',
  'Issue rules:',
  '  - Return between 4 and 10 total issues per audit (unless total is 20/20).',
  '  - Each issue MUST name a specific observable object/location ("red bucket left on walkway near sewing machine 3")',
  '    not a generic description ("clutter present").',
  '  - Severity: "critical" for safety/contamination, "moderate" for workflow impact, "minor" for cosmetic.',
  '',
  'Return STRICT JSON only, no Markdown, no prose outside the JSON.',
].join('\n');

const SYSTEM_PROMPT_SKEPTIC = [
  'You are an ADVERSARIAL 5S auditor whose job is to find problems other auditors missed.',
  'Your career is built on catching issues the line supervisor dismissed as "no big deal".',
  'Assume the photo is hiding problems. Look specifically for:',
  '  - Items stored outside designated zones, on the floor, or on top of other items',
  '  - Wrong item in wrong zone (e.g. fabric in trim area, tools on fabric rack)',
  '  - Missing visual controls: labels, floor lines, shadow boards, SOP charts',
  '  - Dust, oil, lint, thread scraps, fabric offcuts on floor or surfaces',
  '  - Safety concerns: blocked walkways, missing PPE, exposed wiring, unsafe stacking',
  '  - Sustain failures: torn/missing signage, bent partitions, faded markings',
  '',
  'Use the same 1..4 rubric as any 5S auditor, but bias toward the lower score when judgement is ambiguous.',
  'Return STRICT JSON only, matching the schema. A score of 4 is exceptional and should be rare.',
].join('\n');

function buildUserPrompt(zone, history) {
  const rules = [
    `Zone: ${zone.code} - ${zone.name} (${zone.category}).`,
    `Allowed items (do not flag for Sort): ${(zone.allowedItems || []).join(', ') || 'none'}.`,
    `Must-have items (missing = Standardize/Sustain penalty): ${(zone.mustHave || []).join(', ') || 'none'}.`,
    `Forbidden items (always flag for Sort, severity critical): ${(zone.forbidden || []).join(', ') || 'none'}.`,
    `Clutter limit (occupied floor ratio before Sort penalty): ${zone.clutterLimit ?? 0.2}.`,
  ].join('\n');

  const historySummary = (history || []).slice(0, 3).map((h, i) => {
    const scores = h.scores ? `total=${h.scores.total}/20` : '';
    const count = (h.issues || []).length;
    return `  #${i + 1} ${scores}, ${count} issue(s) previously`;
  }).join('\n');

  const schema = `Schema (return exactly this JSON, no Markdown, no comments):
{
  "scores": { "sort": 1-4, "setInOrder": 1-4, "shine": 1-4, "standardize": 1-4, "sustain": 1-4 },
  "issues": [
    { "s": "sort|setInOrder|shine|standardize|sustain",
      "tag": "snake_case_code",
      "label": "Specific observation naming the object and its location",
      "severity": "minor|moderate|critical",
      "image_index": 0 }
  ],
  "actionPoints": ["imperative verb phrase 1", "imperative verb phrase 2", "..."],
  "summary": "3-4 sentences. Must call out the biggest problems first, not the positives.",
  "remarks": "1 sentence: what the supervisor must tell the team at the next toolbox talk."
}`;

  return [
    '5S rules specific to this zone:',
    rules,
    historySummary ? `Previous audits (most recent first):\n${historySummary}` : 'No prior audits on record for this zone.',
    'Scoring self-check (answer silently before writing JSON, then write JSON):',
    '  1. For each S I scored >= 3, can I name at least one concrete reason it is NOT a 4?',
    '  2. If I scored 17+ total, is every S category independently at the benchmark level?',
    '  3. Did I find at least 4 specific issues across the photos? If not, I am probably missing things.',
    '  4. Did my summary LEAD with the biggest problem, not a compliment?',
    schema,
    'Mandatory counts:',
    '  - If total < 20: issues array MUST have 4 or more entries.',
    '  - actionPoints MUST have 3 or more entries unless total == 20.',
    '  - image_index is 0-based in the order images were attached.',
    'No Markdown. No code fences. No keys other than the ones above. Output JSON only.',
  ].join('\n\n');
}

function buildMessages(zone, imagesBase64, history, variant = 'strict') {
  const content = [
    { type: 'text', text: buildUserPrompt(zone, history) },
    ...imagesBase64.map((dataUrl) => ({
      type: 'image_url',
      image_url: { url: dataUrl.startsWith('data:') ? dataUrl : `data:image/jpeg;base64,${dataUrl}` },
    })),
  ];
  const system = variant === 'skeptic' ? SYSTEM_PROMPT_SKEPTIC : SYSTEM_PROMPT_STRICT;
  return [
    { role: 'system', content: system },
    { role: 'user', content },
  ];
}

function pickKey(provider, explicitKey) {
  const env = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY;
  const key = (explicitKey && explicitKey.trim()) || (env && env.trim()) || '';
  return key;
}

function extractJson(text) {
  if (!text) return null;
  // Accept either pure JSON or JSON wrapped in ```json fences.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { return JSON.parse(candidate.slice(first, last + 1)); } catch (_) { /* fall through */ }
    }
    return null;
  }
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 2;
  return Math.min(4, Math.max(1, v));
}

function normalise(raw, zone, imageCount) {
  const scores = {};
  for (const s of S_KEYS) scores[s] = clampScore(raw?.scores?.[s]);
  scores.total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);

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

  const status = scores.total >= 17 ? 'Green' : scores.total >= 12 ? 'Yellow' : 'Red';

  return {
    zone: { id: zone.id, code: zone.code, name: zone.name, category: zone.category },
    scores,
    status,
    issues: cleanedIssues,
    issuesByS,
    actionPoints: actionPoints.length
      ? actionPoints
      : [`Review ${S_LABELS.sort.toLowerCase()} and ${S_LABELS.shine.toLowerCase()} findings and assign owners.`],
    summary: String(raw?.summary || `${zone.code} ${zone.name}: online vision scored ${scores.total}/20 with ${cleanedIssues.length} issue(s).`),
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

// Canonicalises an issue's label to detect duplicates from the two passes.
function issueKey(issue) {
  return `${issue.s}|${String(issue.label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;
}

// Merge two normalised results into a stricter consensus.
function mergeResults(a, b, zone, imageCount) {
  const scores = {};
  for (const s of S_KEYS) {
    // Floor-average: favour the harsher score when the two passes disagree by >= 2
    const sa = clampScore(a.scores[s]);
    const sb = clampScore(b.scores[s]);
    const mean = (sa + sb) / 2;
    const harsh = Math.min(sa, sb);
    scores[s] = Math.abs(sa - sb) >= 2 ? harsh : Math.floor(mean + 0.5);
    scores[s] = clampScore(scores[s]);
  }

  const seen = new Map();
  for (const src of [a.issues, b.issues]) {
    for (const issue of src || []) {
      const key = issueKey(issue);
      if (!seen.has(key)) {
        seen.set(key, issue);
      } else {
        // If both passes flag the same thing, escalate severity.
        const prev = seen.get(key);
        const rank = { minor: 0, moderate: 1, critical: 2 };
        if ((rank[issue.severity] || 0) > (rank[prev.severity] || 0)) {
          seen.set(key, issue);
        }
      }
    }
  }
  let issues = Array.from(seen.values());

  // Under-count guardrail: if the model scored anything <= 3 but gave us
  // fewer than 4 issues, we don't fabricate fake ones, but we DO refuse to
  // hand out a Green overall. This catches the "19/20 with 1 issue" bug.
  const worstS = Math.min(...S_KEYS.map((s) => scores[s]));
  if (worstS <= 3 && issues.length < 4) {
    // Penalise the two weakest S categories by 1 so the score reflects the
    // implicit "unexplained problems" signal.
    const ranked = [...S_KEYS].sort((x, y) => scores[x] - scores[y]);
    for (const s of ranked.slice(0, Math.max(0, 4 - issues.length))) {
      scores[s] = clampScore(scores[s] - 1);
    }
  }

  // If the model returned a maximum score but also issues, trust the issues:
  // no 20/20 when someone wrote down real problems.
  const total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  if (total >= 19 && issues.length >= 2) {
    scores.setInOrder = clampScore(scores.setInOrder - 1);
  }

  scores.total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  const status = scores.total >= 17 ? 'Green' : scores.total >= 12 ? 'Yellow' : 'Red';

  const issuesByS = S_KEYS.reduce((acc, s) => {
    acc[s] = issues.filter((i) => i.s === s).map((i) => i.label);
    return acc;
  }, {});

  // Prefer the harsher summary (the one that doesn't start with "The area appears...")
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
    status,
    issues,
    issuesByS,
    actionPoints: actionPoints.length ? actionPoints : [
      `Walk the zone again and document Sort and Shine findings with photos.`,
      `Assign owners for the open items and re-audit within one week.`,
    ],
    summary: pickSummary(a.summary, b.summary) || `${zone.code} ${zone.name}: consensus score ${scores.total}/20 with ${issues.length} issue(s) across two independent passes.`,
    remarks: a.remarks || b.remarks || 'Audit evaluated by two independent vision passes; please verify critical findings on the floor.',
    annotations: [],
    annotatedImages: [],
  };
}

/**
 * Dual-pass consensus scoring. We prompt the LLM twice with different
 * system framings (strict auditor + adversarial skeptic) and merge the
 * results. This damps single-call exuberance ("looks great, 19/20!")
 * because the skeptic almost always scores lower and the merge step takes
 * the harsher of the two when the gap is large. The passes run in parallel,
 * so the total audit time is roughly one LLM round-trip, not two.
 */
export async function scoreWithLLM({ zoneId, imagesBase64, history, provider, model, apiKey }) {
  const zone = resolveZone(zoneId);
  if (!zone) throw new Error(`Unknown zone: ${zoneId}`);

  const key = pickKey(provider, apiKey);
  if (!key) {
    throw new Error(`No API key available for provider "${provider}". Save one in Settings or set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY'} in .env.`);
  }

  const url = provider === 'openai' ? OPENAI_URL : GROQ_URL;

  const runPass = async (variant, temperature) => {
    const messages = buildMessages(zone, imagesBase64, history, variant);
    const { text } = await callOpenAICompatible({ url, apiKey: key, model, messages, temperature });
    const parsed = extractJson(text);
    if (!parsed) throw new Error(`LLM (${variant}) returned invalid JSON`);
    return normalise(parsed, zone, imagesBase64.length);
  };

  // Two passes in parallel; if one fails, we still return the other.
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

/**
 * Used by the /api/ai/test route. Makes the smallest possible request so the
 * user can see a round-trip latency before they commit their key.
 */
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

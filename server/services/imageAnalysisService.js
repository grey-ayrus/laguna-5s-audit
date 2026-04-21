/**
 * Thin Node bridge to the Python AI engine with an optional LLM side-channel.
 *
 * Default path: POST to the Flask micro-service (YOLO + OpenCV + rule engine).
 * The Python engine still returns scores on the legacy 1..4 scale; this
 * module converts them to the new 1..36 per-S scale so the rest of the
 * server only deals with one numeric range.
 *
 * If the caller supplies `aiProvider` = 'openai' | 'groq', we first try to
 * score the images with the chosen vision LLM via `llmVisionService`. That
 * call receives the zone's reference image alongside the captures and
 * scores the deviation. If it fails for any reason - bad key, rate limit,
 * network blip, unreadable image - we fall back to the Python engine.
 *
 * If both paths are down we return a conservative neutral fallback that is
 * clearly marked "service unavailable" so nobody confuses it with a real
 * audit result.
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { resolveZone } from '../config/zones.js';
import { scoreWithLLM, isOnlineProvider } from './llmVisionService.js';

dotenv.config();

const EXPLICIT_ENGINE_URL = process.env.ENGINE_URL || process.env.OPENCV_SERVICE_URL;
const ENGINE_URL = EXPLICIT_ENGINE_URL || 'http://localhost:5001';

// On Vercel the Python engine cannot run (serverless 250 MB limit vs PyTorch's
// multi-GB install). Skip the local call unless the operator explicitly set
// ENGINE_URL to a reachable external host.
const PYTHON_AVAILABLE = !process.env.VERCEL || Boolean(EXPLICIT_ENGINE_URL);

const DEFAULT_TIMEOUT_MS = 90_000;

const S_KEYS = ['sort', 'setInOrder', 'shine', 'standardize', 'sustain'];
const SCORE_MAX_PER_S = 36;
const SCORE_MAX_TOTAL = SCORE_MAX_PER_S * S_KEYS.length; // 180

function clamp(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function finalScore(total, imageCount) {
  const images = Math.max(1, Number(imageCount) || 1);
  return Math.round((total / (SCORE_MAX_TOTAL * images) * 10) * 100) / 100;
}

function statusForFinal(totalFinal) {
  if (totalFinal >= 8.0) return 'Green';
  if (totalFinal >= 5.0) return 'Yellow';
  return 'Red';
}

// The local Python engine still returns /4 scores. Map each S from 1..4 to
// the new 1..36 range (×9 so that 4 -> 36, 3 -> 27, 2 -> 18, 1 -> 9).
function liftPythonScores(raw, imageCount) {
  const scores = {};
  for (const s of S_KEYS) scores[s] = clamp(Number(raw?.[s]) * 9, 1, SCORE_MAX_PER_S);
  scores.total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  scores.imageCount = imageCount;
  scores.totalFinal = finalScore(scores.total, imageCount);
  return scores;
}

export async function analyzeAudit({ zoneId, imagesBase64, referenceImage, history, aiProvider, aiModel, aiKey }) {
  const zone = resolveZone(zoneId);
  if (!zone) {
    throw new Error(`Unknown zone: ${zoneId}`);
  }

  let llmError = null;

  if (isOnlineProvider(aiProvider)) {
    try {
      const llmResult = await scoreWithLLM({
        zoneId: zone.id,
        imagesBase64,
        referenceImage,
        history,
        provider: aiProvider,
        model: aiModel,
        apiKey: aiKey,
      });
      return {
        ...llmResult,
        engine: `llm:${aiProvider}:${aiModel}`,
      };
    } catch (err) {
      llmError = err;
      console.warn(`LLM (${aiProvider}/${aiModel}) scoring failed, falling back to local engine:`, err.message);
    }
  }

  if (PYTHON_AVAILABLE) {
    try {
      const response = await axios.post(`${ENGINE_URL}/analyze`, {
        zoneId: zone.id,
        images: imagesBase64,
        history,
      }, { timeout: DEFAULT_TIMEOUT_MS, maxContentLength: Infinity, maxBodyLength: Infinity });

      const data = response.data || {};
      const scores = liftPythonScores(data.scores || {}, imagesBase64.length);
      return {
        ...data,
        scores,
        status: statusForFinal(scores.totalFinal),
        engine: 'python',
      };
    } catch (error) {
      console.error('AI engine unavailable, returning neutral fallback:', error.message);
    }
  } else {
    console.warn('Skipping Python engine on Vercel (no ENGINE_URL configured) - returning fallback.');
  }

  return { ...buildFallback(zone, imagesBase64.length, { llmError, aiProvider }), engine: 'fallback' };
}

function buildFallback(zone, imageCount, context = {}) {
  const { llmError, aiProvider } = context;
  const onVercelWithoutEngine = process.env.VERCEL && !EXPLICIT_ENGINE_URL;
  const providerAttempted = isOnlineProvider(aiProvider);

  const llmReason = llmError ? String(llmError.message || llmError).slice(0, 180) : null;

  const actionPoints = llmReason
    ? [
        `Re-take the photo(s): higher resolution, better lighting, and make sure the zone is clearly in frame.`,
        `If the issue repeats, open Settings and try a different model or provider.`,
        `LLM error recorded: ${llmReason}`,
      ]
    : onVercelWithoutEngine
      ? [
          'Open Settings and choose an online vision model (OpenAI or Groq), paste an API key, then re-run the audit.',
          'Alternatively, deploy the Python engine on a traditional host and set ENGINE_URL in the Vercel project.',
        ]
      : [
          'AI engine is currently offline - results require manual verification.',
          'Restart the Python service (npm run engine) and re-run the audit.',
        ];

  // Baseline /36 per S corresponding to 5.00/10 (half marks) so status = Yellow.
  const baselinePerS = Math.round(SCORE_MAX_PER_S / 2); // 18
  const scores = {
    sort: baselinePerS,
    setInOrder: baselinePerS,
    shine: baselinePerS,
    standardize: baselinePerS,
    sustain: baselinePerS,
  };
  scores.total = S_KEYS.reduce((sum, s) => sum + scores[s], 0);
  scores.imageCount = Math.max(1, imageCount || 1);
  scores.totalFinal = finalScore(scores.total, scores.imageCount);

  const summary = llmReason
    ? `${zone.code} ${zone.name} could not be scored: the vision model rejected the request (${llmReason}). A neutral baseline score of ${scores.totalFinal.toFixed(2)}/10.00 has been recorded - please re-take the photos and re-submit.`
    : onVercelWithoutEngine
      ? `${zone.code} ${zone.name} was not analysed because no AI provider is configured. Choose an online model in Settings or configure ENGINE_URL to enable scoring.`
      : `${zone.code} ${zone.name} could not be analysed automatically because the AI engine is offline. A neutral baseline score of ${scores.totalFinal.toFixed(2)}/10.00 has been recorded; please re-audit once the service is back online.`;

  const remarks = llmReason
    ? `Audit not scored: ${providerAttempted ? 'online model returned an error' : 'no scoring engine available'}. Baseline values used.`
    : 'Audit completed using fallback mode - no AI inference was performed.';

  return {
    zone: { id: zone.id, code: zone.code, name: zone.name, category: zone.category },
    scores,
    issues: [],
    issuesByS: { sort: [], setInOrder: [], shine: [], standardize: [], sustain: [] },
    highlights: [],
    actionPoints,
    summary,
    remarks,
    annotations: [],
    annotatedImages: [],
    status: statusForFinal(scores.totalFinal),
  };
}

/**
 * Thin Node bridge to the Python AI engine with an optional LLM side-channel.
 *
 * Default path: POST to the Flask micro-service (YOLO + OpenCV + rule engine).
 *
 * If the caller supplies `aiProvider` = 'openai' | 'groq' (selected from the
 * Settings page), we first try to score the images with the chosen vision
 * LLM via `llmVisionService`. If that call fails for any reason — bad key,
 * rate limit, network blip — we silently fall back to the local Python
 * engine so the auditor never gets left with nothing.
 *
 * If both paths are down, we return a conservative neutral fallback that is
 * clearly marked as "service unavailable" so nobody mistakes it for a real
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

export async function analyzeAudit({ zoneId, imagesBase64, history, aiProvider, aiModel, aiKey }) {
  const zone = resolveZone(zoneId);
  if (!zone) {
    throw new Error(`Unknown zone: ${zoneId}`);
  }

  // Capture the last LLM failure so the fallback can tell the user why we
  // could not score (e.g. "image too small" vs "API key missing") instead
  // of always claiming no provider was configured.
  let llmError = null;

  if (isOnlineProvider(aiProvider)) {
    try {
      const llmResult = await scoreWithLLM({
        zoneId: zone.id,
        imagesBase64,
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

      return { ...response.data, engine: 'python' };
    } catch (error) {
      console.error('AI engine unavailable, returning neutral fallback:', error.message);
    }
  } else {
    console.warn('Skipping Python engine on Vercel (no ENGINE_URL configured) - returning fallback.');
  }

  return { ...buildFallback(zone, { llmError, aiProvider }), engine: 'fallback' };
}

function buildFallback(zone, context = {}) {
  const { llmError, aiProvider } = context;
  const onVercelWithoutEngine = process.env.VERCEL && !EXPLICIT_ENGINE_URL;
  const providerAttempted = isOnlineProvider(aiProvider);

  // If the LLM was attempted and failed, surface the real reason instead of
  // implying no provider was configured. Common cases: image too small,
  // rate limit, transient 5xx. Keep the message compact and actionable.
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

  const summary = llmReason
    ? `${zone.code} ${zone.name} could not be scored: the vision model rejected the request (${llmReason}). A neutral baseline score of 10/20 has been recorded - please re-take the photos and re-submit.`
    : onVercelWithoutEngine
      ? `${zone.code} ${zone.name} was not analysed because no AI provider is configured. Choose an online model in Settings or configure ENGINE_URL to enable scoring.`
      : `${zone.code} ${zone.name} could not be analysed automatically because the AI engine is offline. A neutral baseline score of 10/20 has been recorded; please re-audit once the service is back online.`;

  const remarks = llmReason
    ? `Audit not scored: ${providerAttempted ? 'online model returned an error' : 'no scoring engine available'}. Baseline values used.`
    : 'Audit completed using fallback mode - no AI inference was performed.';

  return {
    zone: { id: zone.id, code: zone.code, name: zone.name, category: zone.category },
    scores: { sort: 2, setInOrder: 2, shine: 2, standardize: 2, sustain: 2, total: 10 },
    issues: [],
    issuesByS: { sort: [], setInOrder: [], shine: [], standardize: [], sustain: [] },
    actionPoints,
    summary,
    remarks,
    annotations: [],
    annotatedImages: [],
    status: 'Yellow',
  };
}

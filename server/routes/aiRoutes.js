import express from 'express';
import { pingLLM, isOnlineProvider } from '../services/llmVisionService.js';

const router = express.Router();

/**
 * GET /api/ai/test?provider=openai&model=gpt-4o-mini&key=sk-...
 *
 * Used by the Settings page "Test connection" button. The key is sent as a
 * query param so we keep the handler trivial; it is never logged and never
 * written to disk. For the `local` provider we short-circuit to a fake OK
 * so the UX is consistent.
 */
router.get('/test', async (req, res) => {
  const { provider, model, key } = req.query;
  if (!provider) {
    return res.status(400).json({ ok: false, error: 'provider is required' });
  }
  if (provider === 'local') {
    return res.json({ ok: true, latencyMs: 0, reply: 'local engine' });
  }
  if (!isOnlineProvider(provider)) {
    return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` });
  }
  if (!model) {
    return res.status(400).json({ ok: false, error: 'model is required' });
  }
  try {
    const result = await pingLLM({ provider, model, apiKey: key });
    res.json(result);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const detail = body?.error?.message || body?.error || err.message || 'Unknown error';
    res.status(200).json({
      ok: false,
      error: status ? `HTTP ${status}: ${detail}` : detail,
    });
  }
});

export default router;

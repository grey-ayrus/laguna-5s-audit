/**
 * Small helper for the Settings page + NewAudit submit path.
 *
 * Keeps the user's preferred vision provider, model, and (optionally) their own
 * API key in localStorage only. We never log the key, and the backend only sees
 * it when an audit is actually submitted — it's not persisted server-side.
 */

const STORAGE_KEY = 'laguna.aiSettings';

export const PROVIDERS = [
  {
    id: 'local',
    label: 'Local (OpenCV + YOLO)',
    description: 'Runs on the bundled Python engine. No key needed, works fully offline.',
    needsKey: false,
    models: [
      { id: 'opencv', label: 'OpenCV + YOLOv8 (default)' },
    ],
    keyHint: '',
    keyUrl: null,
  },
  {
    id: 'openai',
    label: 'OpenAI Vision',
    description: 'Uses chat.completions with vision-capable models.',
    needsKey: true,
    models: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini (fast, cheap)' },
      { id: 'gpt-4o', label: 'gpt-4o (highest quality)' },
    ],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    label: 'Groq (Llama Vision)',
    description: 'OpenAI-compatible API, very low latency.',
    needsKey: true,
    models: [
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'llama-4-scout (vision, default)' },
    ],
    keyHint: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
  },
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

const DEFAULT_SETTINGS = {
  provider: 'local',
  model: 'opencv',
  apiKey: '',
};

export function getAiSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const provider = getProvider(parsed.provider);
    const model = provider.models.some((m) => m.id === parsed.model)
      ? parsed.model
      : provider.models[0].id;
    return {
      provider: provider.id,
      model,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch (err) {
    console.warn('Failed to read AI settings, resetting to defaults', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export function setAiSettings(next) {
  const merged = { ...getAiSettings(), ...next };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function clearAiSettings() {
  localStorage.removeItem(STORAGE_KEY);
}

// Redacts the key for display so supervisors demoing on a projector don't leak it.
export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}

/**
 * Shape the POST /api/audits body uses when the user has chosen a non-local
 * provider. Keeping the call-site tiny: callers spread `aiPayload(settings)`.
 */
export function aiPayload(settings) {
  if (!settings || settings.provider === 'local') return {};
  return {
    aiProvider: settings.provider,
    aiModel: settings.model,
    aiKey: settings.apiKey || undefined,
  };
}

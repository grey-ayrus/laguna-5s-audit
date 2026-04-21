/**
 * Loader for the per-zone "reference" / "standard" images.
 *
 * Reference images live in `server/reference-images/zone-<N>.jpg`. They
 * are bundled with the serverless function on Vercel because the path is
 * statically known at build time (Vercel's tracer follows fs.readFileSync
 * calls against a known path).
 *
 * The loader returns a data URL so the image can be passed straight into
 * the vision LLM alongside the captured photos.
 *
 * If a reference is missing we degrade gracefully to null; the LLM scorer
 * handles both the "compared" and "standalone" cases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCES_DIR = path.resolve(HERE, '..', 'reference-images');

const cache = new Map();

export function loadReferenceImageForZone(zoneId) {
  if (!zoneId || typeof zoneId !== 'string') return null;
  const n = Number(zoneId.replace('zone-', ''));
  if (!Number.isFinite(n)) return null;

  if (cache.has(n)) return cache.get(n);

  const filePath = path.join(REFERENCES_DIR, `zone-${n}.jpg`);
  try {
    if (!fs.existsSync(filePath)) {
      cache.set(n, null);
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    cache.set(n, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn(`Reference image load failed for zone ${n}:`, err.message);
    cache.set(n, null);
    return null;
  }
}

export function referenceImageExists(zoneId) {
  if (!zoneId || typeof zoneId !== 'string') return false;
  const n = Number(zoneId.replace('zone-', ''));
  if (!Number.isFinite(n)) return false;
  return fs.existsSync(path.join(REFERENCES_DIR, `zone-${n}.jpg`));
}

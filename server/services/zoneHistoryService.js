/**
 * Per-zone rolling audit history, persisted across serverless restarts.
 *
 * Each zone keeps the most recent N audits (N = HISTORY_LIMIT) as a single
 * JSON blob at `zone-history/<zone-id>.json`. On Vercel we use @vercel/blob;
 * for local dev without a BLOB_READ_WRITE_TOKEN we fall back to the
 * `server/data/zone-history/` directory on disk.
 *
 * Audits written here use a `blob_` id prefix so the controller can tell
 * them apart from Mongo ObjectIds and the in-memory `mem_` ids.
 *
 * The JSON stored is the same shape the API hands back to the frontend -
 * we just drop the raw base64 image payloads (those already live in
 * Vercel Blob as separate URLs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');
const LOCAL_DIR = path.join(ROOT_DIR, 'server', 'data', 'zone-history');

export const HISTORY_LIMIT = 3;

const HAS_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

let blobLib = null;
async function getBlob() {
  if (!HAS_BLOB) return null;
  if (!blobLib) blobLib = await import('@vercel/blob');
  return blobLib;
}

// Cache the public URLs of zone-history blobs so we don't hit `list()` on
// every read. Populated on first read per zone.
const urlCache = new Map(); // zoneId -> https URL

function pathnameFor(zoneId) {
  return `zone-history/${zoneId}.json`;
}

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
}

function localPathFor(zoneId) {
  return path.join(LOCAL_DIR, `${zoneId}.json`);
}

async function findBlobUrl(zoneId) {
  if (urlCache.has(zoneId)) return urlCache.get(zoneId);
  const blob = await getBlob();
  if (!blob) return null;
  try {
    const { blobs } = await blob.list({ prefix: pathnameFor(zoneId) });
    const match = blobs.find((b) => b.pathname === pathnameFor(zoneId));
    if (match) {
      urlCache.set(zoneId, match.url);
      return match.url;
    }
  } catch (err) {
    console.warn(`zoneHistory list failed for ${zoneId}:`, err.message);
  }
  return null;
}

async function readBlobJson(zoneId) {
  const url = await findBlobUrl(zoneId);
  if (!url) return [];
  try {
    // Append a cache-buster so we don't read the CDN's stale cached copy
    // after a put() that happened seconds ago.
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.warn(`zoneHistory read failed for ${zoneId}:`, err.message);
    return [];
  }
}

async function writeBlobJson(zoneId, audits) {
  const blob = await getBlob();
  if (!blob) return false;
  const body = JSON.stringify(audits);
  try {
    const { url } = await blob.put(pathnameFor(zoneId), body, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    urlCache.set(zoneId, url);
    return true;
  } catch (err) {
    console.error(`zoneHistory write failed for ${zoneId}:`, err.message);
    return false;
  }
}

async function readLocalJson(zoneId) {
  try {
    const file = localPathFor(zoneId);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.warn(`zoneHistory local read failed for ${zoneId}:`, err.message);
    return [];
  }
}

function writeLocalJson(zoneId, audits) {
  try {
    ensureLocalDir();
    fs.writeFileSync(localPathFor(zoneId), JSON.stringify(audits, null, 2));
    return true;
  } catch (err) {
    console.error(`zoneHistory local write failed for ${zoneId}:`, err.message);
    return false;
  }
}

export function isEnabled() {
  return true; // Always available (blob in prod, disk in dev)
}

export function usingBlob() {
  return HAS_BLOB;
}

export function newAuditId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `blob_${Date.now()}_${rand}`;
}

/**
 * Read the last N audits for a zone, most-recent first.
 * @param {string} zoneId
 * @returns {Promise<Array>}
 */
export async function readZoneHistory(zoneId) {
  if (!zoneId) return [];
  const list = HAS_BLOB ? await readBlobJson(zoneId) : await readLocalJson(zoneId);
  return list
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, HISTORY_LIMIT);
}

/**
 * Prepend an audit to its zone's history and keep only the most recent N.
 * Returns the audit as stored (with its _id set if not already present).
 */
export async function appendAudit(audit) {
  if (!audit || !audit.zoneId) return audit;
  if (!audit._id) audit._id = newAuditId();
  const existing = HAS_BLOB
    ? await readBlobJson(audit.zoneId)
    : await readLocalJson(audit.zoneId);

  // Deduplicate by _id so a retry of the same write doesn't duplicate.
  const dedup = existing.filter((a) => a._id !== audit._id);
  dedup.unshift(audit);
  const trimmed = dedup
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, HISTORY_LIMIT);

  const ok = HAS_BLOB
    ? await writeBlobJson(audit.zoneId, trimmed)
    : writeLocalJson(audit.zoneId, trimmed);
  return ok ? audit : audit;
}

/**
 * Remove an audit from the history of its zone. If zoneId is unknown we
 * scan all zones (slower but correct). Returns the list of images that were
 * attached to the deleted record so the caller can purge them.
 */
export async function deleteAuditById(id, zoneIdHint = null) {
  if (!id) return null;
  const zonesToScan = zoneIdHint ? [zoneIdHint] : await listKnownZones();
  for (const zoneId of zonesToScan) {
    const list = HAS_BLOB ? await readBlobJson(zoneId) : await readLocalJson(zoneId);
    const idx = list.findIndex((a) => a._id === id);
    if (idx === -1) continue;
    const [removed] = list.splice(idx, 1);
    if (HAS_BLOB) await writeBlobJson(zoneId, list);
    else writeLocalJson(zoneId, list);
    return removed;
  }
  return null;
}

/**
 * Find an audit by id across all zones. Primarily used by
 * `getAuditById` / `downloadAuditPDF` when the audit is not in memory.
 */
export async function findAuditById(id) {
  if (!id) return null;
  const zones = await listKnownZones();
  for (const zoneId of zones) {
    const list = HAS_BLOB ? await readBlobJson(zoneId) : await readLocalJson(zoneId);
    const match = list.find((a) => a._id === id);
    if (match) return match;
  }
  return null;
}

async function listKnownZones() {
  if (HAS_BLOB) {
    const blob = await getBlob();
    if (!blob) return [];
    try {
      const { blobs } = await blob.list({ prefix: 'zone-history/' });
      return blobs
        .map((b) => {
          const m = /zone-history\/(.+)\.json$/.exec(b.pathname);
          return m ? m[1] : null;
        })
        .filter(Boolean);
    } catch (err) {
      console.warn('zoneHistory list all failed:', err.message);
      return [];
    }
  }
  try {
    if (!fs.existsSync(LOCAL_DIR)) return [];
    return fs.readdirSync(LOCAL_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

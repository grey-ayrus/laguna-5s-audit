/**
 * Storage abstraction that decides at runtime whether we are running on
 * Vercel (read-only filesystem, use @vercel/blob) or a traditional server
 * (use the local uploads/ + pdfs/ directories).
 *
 * Production:  BLOB_READ_WRITE_TOKEN is set (or we detect `process.env.VERCEL`).
 *              All writes go to Vercel Blob and return absolute HTTPS URLs.
 * Dev/local:   Files are written to uploads/ and pdfs/ and we return
 *              relative paths (`uploads/foo.jpg`) that the React dev server
 *              proxies to the Express static handler on port 5000.
 *
 * The frontend already copes with both URL shapes: `<img src=\`/${src}\`>`
 * works for `uploads/x.jpg` and we make absolute URLs survive below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..', '..');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const PDFS_DIR = path.join(ROOT_DIR, 'pdfs');

const HAS_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

let blobLib = null;
async function getBlob() {
  if (!HAS_BLOB) return null;
  if (!blobLib) blobLib = await import('@vercel/blob');
  return blobLib;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Persist a single image buffer.
 * @param {{prefix:string,index:number,timestamp:number,buffer:Buffer,contentType?:string}} opts
 * @returns {Promise<string>}   URL usable by the frontend (`<img src=URL>`).
 *                              Absolute https URL in prod, relative in dev.
 */
export async function saveImage({ prefix, index, timestamp, buffer, contentType = 'image/jpeg' }) {
  const filename = `${prefix}_${timestamp}_${index}.jpg`;
  const blob = await getBlob();
  if (blob) {
    const { url } = await blob.put(`uploads/${filename}`, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return url;
  }
  // On serverless without Blob configured, the filesystem is read-only.
  // Embed the image directly as a base64 data URI so the audit still renders
  // (works everywhere, no dead <img> links).
  if (process.env.VERCEL) {
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }
  ensureDir(UPLOADS_DIR);
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `uploads/${filename}`;
}

/**
 * Best-effort image delete. Never throws: the caller is deleting an audit
 * and a stale/missing image should not block the record from being removed.
 * Returns `true` if something was actually deleted.
 *
 * - Absolute https Blob URL  -> @vercel/blob `del()`
 * - Local relative path      -> fs.unlink
 * - data: URI / null / unknown shape -> no-op
 */
export async function deleteImage(urlOrPath) {
  if (!urlOrPath || typeof urlOrPath !== 'string') return false;
  if (urlOrPath.startsWith('data:')) return false;

  try {
    if (/^https?:\/\//i.test(urlOrPath)) {
      const blob = await getBlob();
      if (!blob) return false;
      await blob.del(urlOrPath);
      return true;
    }
    const full = path.isAbsolute(urlOrPath) ? urlOrPath : path.join(ROOT_DIR, urlOrPath);
    if (fs.existsSync(full)) {
      fs.unlinkSync(full);
      return true;
    }
  } catch (err) {
    console.warn(`deleteImage(${urlOrPath.slice(0, 60)}) failed:`, err.message);
  }
  return false;
}

/**
 * For legacy / already-saved image URLs: returns a Buffer for PDF embedding.
 * Works with both absolute blob URLs and local `uploads/foo.jpg` paths.
 */
export async function loadImageBuffer(urlOrPath) {
  if (!urlOrPath) return null;
  if (urlOrPath.startsWith('data:')) {
    const comma = urlOrPath.indexOf(',');
    if (comma < 0) return null;
    return Buffer.from(urlOrPath.slice(comma + 1), 'base64');
  }
  if (/^https?:\/\//i.test(urlOrPath)) {
    const res = await fetch(urlOrPath);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  const full = path.isAbsolute(urlOrPath) ? urlOrPath : path.join(ROOT_DIR, urlOrPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

export function isServerless() {
  return HAS_BLOB || Boolean(process.env.VERCEL);
}

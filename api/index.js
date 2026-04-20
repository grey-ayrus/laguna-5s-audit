/**
 * Vercel serverless entry. Vercel maps `api/index.js` to a function that
 * handles every request matched by `vercel.json`'s rewrites. We reuse the
 * exact same Express app that powers the local dev server.
 *
 * The cold-start path calls `connectMongoOnce()` once per container; the
 * promise is cached so subsequent invocations are free.
 */
import { buildApp, connectMongoOnce } from '../server/app.js';

connectMongoOnce();
const app = buildApp();

export default function handler(req, res) {
  return app(req, res);
}

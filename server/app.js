/**
 * Builds and configures the Express application. Kept separate from
 * `server/index.js` so both the local dev server and the Vercel serverless
 * entry at `api/index.js` can share the exact same wiring without racing
 * two copies of the handler/listener.
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import auditRoutes from './routes/auditRoutes.js';
import aiRoutes from './routes/aiRoutes.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

mongoose.set('bufferCommands', false);

global.mongoConnected = false;
let mongoConnectPromise = null;

export function connectMongoOnce() {
  if (mongoConnectPromise) return mongoConnectPromise;
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn('MONGODB_URI not set - using in-memory storage');
    mongoConnectPromise = Promise.resolve(false);
    return mongoConnectPromise;
  }
  mongoConnectPromise = mongoose
    .connect(mongoUri, { serverSelectionTimeoutMS: 3000 })
    .then(() => {
      console.log('MongoDB connected');
      global.mongoConnected = true;
      return true;
    })
    .catch((err) => {
      console.warn(`MongoDB unavailable (${err.message}) - using in-memory storage`);
      return false;
    });
  return mongoConnectPromise;
}

export function buildApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Local-only static for images saved to disk. On Vercel the filesystem is
  // read-only and images come from Vercel Blob (absolute URLs the frontend
  // already knows how to render), so the static middleware is a no-op there.
  const uploadsDir = join(__dirname, '../uploads');
  if (fs.existsSync(uploadsDir)) {
    app.use('/uploads', express.static(uploadsDir));
  }

  app.use('/api/audits', auditRoutes);
  app.use('/api/ai', aiRoutes);

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'OK',
      message: 'Laguna 5S Audit System Running',
      storage: global.mongoConnected ? 'mongodb' : 'in-memory',
      serverless: Boolean(process.env.VERCEL),
    });
  });

  return app;
}

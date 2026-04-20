# Laguna India - 5S AI Audit System

Production-grade web application for **5S audit and monitoring** in the Laguna
India apparel manufacturing factory at **Doddaballapura**.

The system evaluates 5S compliance (Sort, Set in Order, Shine, Standardize,
Sustain) using **image-based AI analysis combined with zone-aware rule-based
validation**. There is no reference image required - the AI knows what each of
the 26 zones is supposed to look like.

---

## Quick start (the only commands you need)

You need **two** things installed on your machine:

1. **Node.js 18 or newer** -> https://nodejs.org
2. **Python 3.8 - 3.13**   -> https://www.python.org/downloads/
   - Tick "Add Python to PATH" on the first installer screen.

Then, from the project root:

```bash
npm install
npm run dev
```

That's it. The first command bootstraps everything (Node + React deps, a
local Python virtualenv, OpenCV, Flask, YOLOv8 weights). The second command
starts all three services together.

When you see all three banners come up, open the app at:

> http://localhost:3000

| Service          | Port | What it does                                |
|------------------|------|---------------------------------------------|
| React (Vite)     | 3000 | The UI you open in the browser              |
| Node API         | 5000 | REST endpoints + audit persistence + PDFs   |
| Python AI engine | 5001 | YOLOv8 + OpenCV + 5S rule engine            |

To stop everything, press **Ctrl+C** once.

---

## What `npm install` actually does for you

The `postinstall` hook runs `scripts/setup.mjs`, which performs the following
steps in order. It is fully idempotent - running it again is fast and safe.

1. Installs the Node API dependencies (already done by `npm install` itself).
2. Installs the React client dependencies in `client/`.
3. Detects your system Python (3.8 - 3.13).
4. Creates a local Python virtual environment at `./.venv`.
5. Installs Flask, OpenCV, NumPy, Pillow into the venv.
6. Installs YOLOv8 (`ultralytics`) into the same venv.
7. Pre-downloads the YOLOv8n weights into `python/yolov8n.pt` so the first
   audit doesn't have to wait for a network download.
8. Creates `uploads/` and `pdfs/` if missing.
9. Creates `.env` from `.env.example` if missing.

If Python is missing, steps 3-7 are skipped with a clear warning - you can
install Python and rerun `npm run setup` at any time.

If the YOLO/PyTorch install fails (most often on Windows because of long path
restrictions), the engine transparently falls back to OpenCV-only detection
and the rest of the system keeps working.

---

## Architecture

```
+------------------+        +-------------------+        +----------------------+
|  React frontend  | <----> |  Node/Express API | <----> |  Python AI engine    |
|  (Vite, port 3000)        |  (port 5000)      |  HTTP  |  (Flask, port 5001)  |
+------------------+        +---------+---------+        +-----+----------------+
                                      |                        |
                                      v                        v
                              MongoDB or in-memory     YOLOv8 + OpenCV + zone rules
```

- **Frontend (React 18 + Vite + Recharts)**: Pick a zone -> upload or capture
  1-4 images -> see scored result with annotated images, severity-coloured
  issues and action points.
- **Backend (Node 18 + Express)**: Bridges the browser to the Python engine,
  persists audits in MongoDB (or in-memory if MongoDB is not reachable),
  generates PDF reports, exposes the canonical 26-zone catalogue.
- **AI engine (Python 3.8+)**: YOLOv8 (small COCO model) handles object
  detection; OpenCV handles dirt/scrap/oil/clutter heuristics; a
  zone-aware rule engine turns the raw signals into 5S issues, scores and
  factory-specific action points.

---

## Configuration (optional)

The defaults work out of the box. Edit `.env` only if you need to override
something:

```
PORT=5000
MONGODB_URI=mongodb://localhost:27017/laguna-5s-audit
ENGINE_URL=http://localhost:5001
NODE_ENV=development

# Optional server-side fallback keys for the online vision providers.
# End-users can also paste their own key into the in-app Settings page.
# OPENAI_API_KEY=sk-...
# GROQ_API_KEY=gsk_...
```

If MongoDB is not reachable, audits are kept in-memory for the lifetime of
the process. This is fine for trials and demos. For production, install
MongoDB locally or point `MONGODB_URI` at a managed instance.

---

## Camera, Online Models, and Install on Home Screen

The app ships three quality-of-life features on top of the core local engine:

### 1. Camera capture (native + live)

On the **New Audit** screen:

- **Upload images** — pick existing files from the device.
- **Capture with camera** — phones/tablets get the OS camera app directly.
- **Live camera** — laptops, kiosks and anyone else get an in-app modal that
  opens the webcam, lets you flip between front/back, take a photo, retake
  if needed, and commit. Requires camera permission the first time.

The buttons auto-hide based on what the device can do, so there's no extra
config to fiddle with.

### 2. Choose an online vision model (optional)

By default the app runs fully local (OpenCV + YOLOv8 through the bundled
Python engine). If you want to try a cloud model instead:

1. Click **Settings** in the top bar.
2. Pick a provider — **OpenAI** (`gpt-4o`, `gpt-4o-mini`) or
   **Groq** (`meta-llama/llama-4-scout-17b-16e-instruct`).
3. Paste your API key and click **Test connection**.
4. Click **Save**. Every new audit now scores through that model.
5. Switch back to **Local** at any time.

API keys live only in your browser's localStorage and are sent straight to
the provider you chose. The server never writes them to disk.

**How the online scoring works (dual-pass consensus).** Every audit makes
**two** LLM calls in parallel with slightly different framings: one strict
"head auditor" pass and one adversarial "skeptic" pass. The server then
merges the two:

- scores are averaged, but when the two passes disagree by 2+ points on any
  S, the harsher score wins
- issues are de-duplicated and escalated in severity when both passes flag
  the same thing
- a post-processing guard refuses to hand out 20/20 when issues are present

This damps single-call exuberance (a lone LLM call sometimes returns
"19/20 Green" with only one issue on a visibly cluttered zone) and pushes
typical messy factory photos into the 10-14/20 Yellow/Red band they
actually deserve. The trade-off is roughly doubled round-trip time
(~3-5 s total), which is acceptable for audits.

If the LLM call fails for any reason (bad key, rate limit, network blip,
image too small), the audit transparently falls back to the local Python
engine (or a neutral baseline on Vercel) with a clear failure reason in the
action points, so the supervisor on the floor is never left empty-handed.

### 3. Install on your Home Screen (PWA)

The app is a progressive web app with an offline app-shell cached by a
service worker:

- **Android / Chrome / Edge**: an **"Install app"** pill shows up on the
  dashboard. Tap it, then confirm the OS prompt.
- **iOS Safari**: tap **Share → Add to Home Screen**. A hint banner on the
  dashboard walks you through it.
- **Desktop Chrome/Edge**: the address bar shows an install icon as well.

Once installed, the app launches like a native app (no browser chrome). The
UI loads offline; audits themselves still need the server/internet because
image analysis happens on the backend.

---

## Zone catalogue and scoring

All 26 zones are defined in [`server/config/zones.js`](server/config/zones.js)
(mirrored to [`python/zones.json`](python/zones.json)). Each zone declares:

- `allowedItems`  - what's expected to be in the zone (do not flag for Sort).
- `mustHave`      - what the zone needs to have (signage, labels, ...).
- `forbidden`     - what should never be there (food, fabric scrap, ...).
- `clutterLimit`  - max edge-density before clutter is flagged.

Edit those files to tune the rule engine for any zone.

Each S is bucketed from a weighted issue count:

| Weighted issues | Score |
|-----------------|-------|
| 0               | 4     |
| 1-2             | 3     |
| 3-4             | 2     |
| 5+              | 1     |

Critical issues (forbidden item, oil stain, food waste, declining trend)
count as 2 issues each. The total of all five S scores ranges from 5 to 20:

| Total | Status |
|-------|--------|
| 16-20 | Green  |
| 11-15 | Yellow |
| 5-10  | Red    |

---

## API reference

| Method | Path                       | Description                                               |
|--------|----------------------------|-----------------------------------------------------------|
| GET    | `/api/audits/zones`        | List the 26 zones                                         |
| GET    | `/api/audits`              | List audits (filter by `zoneId`, `startDate`, `endDate`)  |
| GET    | `/api/audits/stats`        | Dashboard stats (avg per zone, status distribution, trend)|
| POST   | `/api/audits`              | Create a new audit (`{zoneId, images:[base64,...]}`)      |
| GET    | `/api/audits/:id`          | Get a specific audit                                      |
| GET    | `/api/audits/:id/pdf`      | Download the PDF report for that audit                    |
| GET    | `/api/ai/test`             | Test an online provider key (`?provider=&model=&key=`)    |
| GET    | `/api/health`              | Liveness check                                            |

---

## Project layout

```
fas/
+-- api/
|   +-- index.js                       Vercel serverless entry (wraps server/app.js)
+-- server/                            Node API
|   +-- index.js                       Local dev entry point
|   +-- app.js                         Shared Express app factory + Mongo connector
|   +-- config/zones.js                26-zone catalogue
|   +-- models/Audit.js                Mongoose schema (v2)
|   +-- controllers/auditController.js
|   +-- routes/auditRoutes.js          Audit CRUD
|   +-- routes/aiRoutes.js             /api/ai/test for the Settings UI
|   +-- services/
|       +-- imageAnalysisService.js    Bridge to Python engine + LLM router
|       +-- llmVisionService.js        OpenAI / Groq vision client
|       +-- storageService.js          Vercel Blob in prod, disk in dev
|       +-- pdfService.js              In-memory PDF report generation
+-- python/                            AI engine
|   +-- image_analyzer.py              Flask service (POST /analyze)
|   +-- detector.py                    YOLOv8 + OpenCV detection
|   +-- rules.py                       Zone-aware 5S rule engine
|   +-- zones.json                     26-zone catalogue (mirror)
|   +-- requirements.txt               Core deps (Flask, OpenCV, NumPy, Pillow)
|   +-- requirements-yolo.txt          ultralytics (YOLOv8)
|   +-- tests/                         Detector precision tests
|   +-- fixtures/                      Sample factory photos
+-- client/                            React frontend (PWA)
|   +-- public/icons/                  Generated PWA home-screen icons
|   +-- src/App.jsx
|   +-- src/main.jsx                   Registers the service worker
|   +-- src/lib/aiSettings.js          Provider/model/key helpers (localStorage)
|   +-- src/components/
|       +-- Dashboard.jsx
|       +-- NewAudit.jsx
|       +-- AuditDetails.jsx
|       +-- Settings.jsx               Online provider + API key picker
|       +-- CameraCapture.jsx          In-app live webcam modal
|       +-- InstallPrompt.jsx          "Install on Home screen" pill
+-- scripts/
|   +-- setup.mjs                      Cross-platform postinstall bootstrap
|   +-- run-engine.mjs                 Cross-platform Python launcher
|   +-- generate-pwa-icons.mjs         Rasterises PNG icons from the logo
|   +-- smoke_test.py                  End-to-end API smoke test
|   +-- test_real_fabric_image.py      Real-photo precision check
|   +-- test_legacy_migration.mjs      Legacy v1 -> v2 migration unit test
+-- uploads/                           Saved original + annotated images (local only)
+-- pdfs/                              Generated PDF reports (local only)
+-- vercel.json                        Vercel build + route config
+-- .vercelignore                      Skips the Python tree, uploads, etc.
+-- package.json
+-- README.md
```

---

## Deploy to Vercel

The repo ships with everything needed for a one-shot Vercel deploy of the
React PWA + the Node Express API as a single serverless function. The
Python YOLO engine does **not** run on Vercel (250 MB function limit vs
PyTorch's multi-GB install); in production every audit is scored by the
online vision model the user selects in Settings (OpenAI or Groq).

### 1. First-time project setup

```bash
npx vercel login
npx vercel link          # attach this folder to a (new) Vercel project
```

### 2. Enable Vercel Blob for image storage

On Vercel's read-only filesystem, `uploads/` and `pdfs/` cannot be
written. The repo routes every image save through
`server/services/storageService.js`, which uses
[Vercel Blob](https://vercel.com/docs/storage/vercel-blob) when the
`BLOB_READ_WRITE_TOKEN` env var is present and falls back to disk
locally.

- Go to the project -> Storage -> Create new -> Blob
- Accept the default store name, click Create & Connect
- Vercel automatically injects `BLOB_READ_WRITE_TOKEN` into every env

### 3. Set the remaining env vars

Project -> Settings -> Environment Variables:

| Name                    | Example                               | Required?                              |
| ----------------------- | ------------------------------------- | -------------------------------------- |
| `MONGODB_URI`           | `mongodb+srv://user:***@cluster/5s`   | Recommended (without it data is lost on every cold start) |
| `GROQ_API_KEY`          | `gsk_...`                             | Recommended (server-side fallback)     |
| `OPENAI_API_KEY`        | `sk-...`                              | Optional                               |
| `ENGINE_URL`            | `https://my-yolo-host.example/analyze`| Optional - URL of external Python engine |
| `BLOB_READ_WRITE_TOKEN` | (auto)                                | Auto-set when Blob is enabled          |

Tip: users can also paste their own key into the in-app Settings page.
Those keys stay in the browser's localStorage and are sent in the audit
request body. Env var keys act as a server-side fallback.

### 4. Deploy

```bash
npx vercel deploy --prod
```

The build step runs `npm --prefix client run build`, Vercel serves
`client/dist/` as the static site, and every request matching `/api/*`
is routed to the serverless function at `api/index.js`, which reuses
the exact same Express app you run locally.

### What changes between dev and Vercel?

| Concern            | Local `npm run dev`                 | Vercel                                   |
| ------------------ | ----------------------------------- | ---------------------------------------- |
| AI scoring         | Python YOLO engine (+ optional LLM) | LLM only (OpenAI / Groq)                 |
| Image storage      | `uploads/` on disk                  | Vercel Blob (absolute HTTPS URLs)        |
| PDF generation     | written to `pdfs/` then streamed    | generated in memory, streamed to client  |
| DB                 | Mongo or in-memory fallback         | Mongo Atlas (recommended)                |
| Camera / PWA / UI  | identical                           | identical                                |

---

## Tests

Once `npm install` has completed:

```bash
# Detector precision (no false positives on real fabric racks)
.venv\Scripts\python python\tests\test_detector_precision.py     # Windows
.venv/bin/python python/tests/test_detector_precision.py         # macOS/Linux

# Full end-to-end through the live API (requires `npm run dev` running)
.venv\Scripts\python scripts\smoke_test.py                       # Windows
.venv/bin/python scripts/smoke_test.py                           # macOS/Linux
```

---

## Built for

**Laguna India Pvt Ltd, Doddaballapura** - smart factory tooling for the
apparel quality team.

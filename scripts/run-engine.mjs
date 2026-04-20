#!/usr/bin/env node
/**
 * Cross-platform launcher for the Python image-analysis engine.
 *
 * Reads `.python-runtime.json` (created by scripts/setup.mjs) to find the
 * exact Python interpreter that the setup process picked - either:
 *   - the local virtualenv at .venv/Scripts/python.exe (or .venv/bin/python)
 *   - or the system Python (when the system already has cv2 + flask).
 *
 * Falls back gracefully to the system 'python' / 'python3' command if the
 * runtime file is missing, so the user gets a useful error instead of a
 * cryptic "command not found".
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const IS_WIN = platform() === "win32";
const RUNTIME_FILE = join(ROOT, ".python-runtime.json");

function fallbackPython() {
  return IS_WIN ? "python" : "python3";
}

let pythonCmd = null;
if (existsSync(RUNTIME_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RUNTIME_FILE, "utf-8"));
    if (data.pythonPath) {
      pythonCmd = data.pythonPath;
      console.log(`[engine] using Python: ${data.label || data.pythonPath}`);
    }
  } catch (err) {
    console.warn(`[engine] could not read ${RUNTIME_FILE}: ${err.message}`);
  }
}

if (!pythonCmd) {
  console.log("[engine] no .python-runtime.json yet - run 'npm run setup' first.");
  console.log(`[engine] falling back to '${fallbackPython()}' on PATH`);
  pythonCmd = fallbackPython();
}

const child = spawn(
  pythonCmd,
  [join(ROOT, "python", "image_analyzer.py")],
  {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, FLASK_DEBUG: process.env.FLASK_DEBUG ?? "true" },
  }
);

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`[engine] failed to start Python: ${err.message}`);
  console.error("[engine] make sure Python 3.8+ is installed and on PATH, then run 'npm run setup'.");
  process.exit(1);
});

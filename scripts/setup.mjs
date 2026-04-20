#!/usr/bin/env node
/**
 * Zero-touch setup for the Laguna 5S Audit System.
 *
 * Run automatically after `npm install` (via `postinstall`) and again before
 * `npm run dev` (via `predev`). Idempotent: rerunning is always safe and
 * fast once everything is in place.
 *
 * What it does, in order:
 *   1. Installs the React client's npm dependencies (client/node_modules).
 *   2. Locates a usable Python interpreter:
 *        a. If the SYSTEM python already has cv2 + flask + numpy + PIL
 *           installed, that interpreter is used directly (no venv needed).
 *        b. Otherwise we try to create a local virtualenv at ./.venv and
 *           pip-install the required packages into it.
 *   3. Installs YOLOv8 (ultralytics) into whichever interpreter we settled
 *      on. If this fails (e.g. PyTorch is too big for the disk, or the
 *      network blocks pip), the engine transparently falls back to
 *      OpenCV-only detection.
 *   4. Pre-downloads yolov8n.pt into ./python so the first audit doesn't
 *      have to wait on a network download.
 *   5. Writes ./.python-runtime.json with the path of the chosen
 *      interpreter so scripts/run-engine.mjs knows what to launch.
 *   6. Creates uploads/ and pdfs/ if missing.
 *   7. Creates .env from .env.example if missing.
 *
 * The script tries hard to NEVER fail outright: every pip step that fails
 * is downgraded to a warning so that, at worst, the user can still run the
 * Node + React parts and a clear message tells them what to fix to get the
 * AI engine online.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const IS_WIN = platform() === "win32";

const VENV_DIR = join(ROOT, ".venv");
const VENV_PY = IS_WIN
  ? join(VENV_DIR, "Scripts", "python.exe")
  : join(VENV_DIR, "bin", "python");

const REQS = join(ROOT, "python", "requirements.txt");
const REQS_YOLO = join(ROOT, "python", "requirements-yolo.txt");
const YOLO_WEIGHTS = join(ROOT, "python", "yolov8n.pt");
const RUNTIME_FILE = join(ROOT, ".python-runtime.json");

let warnings = 0;
let stepNum = 0;

function step(label) {
  stepNum += 1;
  console.log(`\n[${stepNum}] ${label}`);
}
function ok(msg)   { console.log(`    OK   ${msg}`); }
function warn(msg) { warnings += 1; console.log(`    WARN ${msg}`); }
function info(msg) { console.log(`    ...  ${msg}`); }

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd || ROOT,
    shell: false,
    ...opts,
  });
}

function whichPython() {
  // Try several common command names so we work on Windows / macOS / Linux
  // and on Windows boxes that only have the `py` launcher.
  const candidates = IS_WIN
    ? ["python", "py", "python3"]
    : ["python3", "python"];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    if (r.status === 0) {
      const out = ((r.stdout || "").toString() + (r.stderr || "").toString()).trim();
      const m = out.match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (m) {
        const major = Number(m[1]);
        const minor = Number(m[2]);
        if (major === 3 && minor >= 8 && minor <= 13) {
          return { cmd: c, version: out };
        }
      }
    }
  }
  return null;
}

function pythonHasModules(pyCmd, modules) {
  // Returns true iff `python -c "import a, b, c"` exits 0 for the given list.
  const code = `import ${modules.join(", ")}`;
  const r = spawnSync(pyCmd, ["-c", code], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return r.status === 0;
}

function pipInstall(pyCmd, args, label) {
  info(`pip install ${label} (using ${pyCmd})`);
  // Use --trusted-host as a soft-defence against the dreaded corporate
  // SSL-MITM that strips PyPI's certificate. It only takes effect when pip
  // already has trouble validating the cert; otherwise it's a no-op.
  const baseArgs = [
    "-m", "pip", "install",
    "--disable-pip-version-check",
    "--trusted-host", "pypi.org",
    "--trusted-host", "files.pythonhosted.org",
    "--trusted-host", "pypi.python.org",
  ];
  const r = run(pyCmd, [...baseArgs, ...args]);
  return r.status === 0;
}

console.log("============================================");
console.log("  Laguna 5S Audit System - Setup");
console.log("============================================");

// -----------------------------------------------------------------------
step("Installing React client dependencies");
// -----------------------------------------------------------------------
const clientDir = join(ROOT, "client");
if (!existsSync(join(clientDir, "package.json"))) {
  warn("client/package.json missing - skipping client install");
} else if (existsSync(join(clientDir, "node_modules", ".package-lock.json"))) {
  ok("client/node_modules already installed");
} else {
  info("running npm install in client/ ... (~30s)");
  // Use the same npm CLI that invoked us so we don't pick up a stale one.
  const npmCli = process.env.npm_execpath;
  let r;
  if (npmCli && existsSync(npmCli)) {
    r = run(process.execPath, [npmCli, "install", "--no-audit", "--no-fund"], { cwd: clientDir });
  } else {
    r = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: clientDir });
  }
  if (r.status !== 0) {
    warn("client npm install failed - try running it manually: cd client && npm install");
  } else {
    ok("client dependencies installed");
  }
}

// -----------------------------------------------------------------------
step("Detecting system Python (3.8 - 3.13)");
// -----------------------------------------------------------------------
const sysPy = whichPython();
let chosenPython = null;          // path to python.exe / python3 we will use
let chosenLabel = null;           // human label for the chosen interpreter

if (!sysPy) {
  warn("Could not find a Python 3.8-3.13 interpreter on PATH.");
  warn("Install Python from https://www.python.org/downloads/ and rerun:");
  warn("    npm run setup");
  warn("The Node + React parts will still build, but image analysis will be offline.");
} else {
  ok(`found ${sysPy.version} as '${sysPy.cmd}'`);

  // ---------------------------------------------------------------------
  step("Checking whether system Python already has Flask + OpenCV + NumPy + Pillow");
  // ---------------------------------------------------------------------
  if (pythonHasModules(sysPy.cmd, ["flask", "cv2", "numpy", "PIL"])) {
    ok("system Python already has all core deps - using it directly (no venv needed)");
    chosenPython = sysPy.cmd;
    chosenLabel = `system ${sysPy.version}`;
  } else {
    info("system Python is missing one or more deps - will create a local virtualenv");
  }

  // ---------------------------------------------------------------------
  if (!chosenPython) {
    step("Creating Python virtual environment at .venv");
    if (existsSync(VENV_PY)) {
      ok(".venv already exists");
    } else {
      info(`running ${sysPy.cmd} -m venv .venv ...`);
      const r = run(sysPy.cmd, ["-m", "venv", ".venv"]);
      if (r.status !== 0) {
        warn("Failed to create the virtual environment.");
        warn("This usually means the 'venv' module isn't installed (Linux: apt install python3-venv).");
      } else {
        ok(".venv created");
      }
    }

    if (existsSync(VENV_PY)) {
      // --------------------------------------------------------------
      step("Upgrading pip + installing core Python deps into .venv");
      // --------------------------------------------------------------
      pipInstall(VENV_PY, ["--upgrade", "pip"], "(pip itself)");
      const coreOk = pipInstall(VENV_PY, ["-r", REQS], "(Flask, OpenCV, NumPy, Pillow)");
      if (coreOk && pythonHasModules(VENV_PY, ["flask", "cv2", "numpy", "PIL"])) {
        ok("core dependencies installed into .venv");
        chosenPython = VENV_PY;
        chosenLabel = "local virtualenv (.venv)";
      } else {
        warn("Could not install core Python deps into the virtualenv.");
        warn("This is usually a network/SSL issue. Common fixes:");
        warn("  - Make sure the machine can reach https://pypi.org/");
        warn("  - On a corporate network, set HTTP_PROXY / HTTPS_PROXY env vars and rerun:");
        warn("        npm run setup");
      }
    }
  }
}

// -----------------------------------------------------------------------
if (chosenPython) {
  step(`Installing YOLOv8 (ultralytics) into ${chosenLabel}`);
  info("this can take a few minutes the first time (~250 MB of PyTorch wheels)");
  if (pythonHasModules(chosenPython, ["ultralytics"])) {
    ok("ultralytics already installed");
  } else {
    const yoloOk = pipInstall(chosenPython, ["-r", REQS_YOLO], "(ultralytics + torch)");
    if (yoloOk && pythonHasModules(chosenPython, ["ultralytics"])) {
      ok("ultralytics installed");
    } else {
      warn("ultralytics install failed - the engine will run in OpenCV-only mode.");
      warn("On Windows, enable 'Long Paths' (Group Policy: 'Enable Win32 long paths')");
      warn("and rerun:  npm run setup");
    }
  }

  // ---------------------------------------------------------------------
  step("Pre-downloading YOLOv8n weights into ./python");
  // ---------------------------------------------------------------------
  if (existsSync(YOLO_WEIGHTS)) {
    ok("python/yolov8n.pt already present");
  } else if (pythonHasModules(chosenPython, ["ultralytics"])) {
    info("running 'YOLO(\"yolov8n.pt\")' to download the weights ...");
    const dl = run(
      chosenPython,
      ["-c", "from ultralytics import YOLO; YOLO('yolov8n.pt')"],
      { cwd: join(ROOT, "python") }
    );
    if (dl.status === 0 && existsSync(YOLO_WEIGHTS)) {
      ok("yolov8n.pt downloaded into ./python");
    } else {
      warn("Could not pre-download YOLO weights. The engine will retry on first audit.");
    }
  } else {
    info("ultralytics not installed - skipping YOLO weights download");
  }
}

// -----------------------------------------------------------------------
step("Writing .python-runtime.json so the dev server knows which Python to launch");
// -----------------------------------------------------------------------
const runtime = {
  pythonPath: chosenPython,
  label: chosenLabel,
  pickedAt: new Date().toISOString(),
};
writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2) + "\n");
if (chosenPython) {
  ok(`will launch the Python engine with: ${chosenPython}`);
} else {
  warn("no Python interpreter was usable - the engine will not start");
}

// -----------------------------------------------------------------------
step("Ensuring runtime folders exist (uploads/, pdfs/)");
// -----------------------------------------------------------------------
for (const dir of ["uploads", "pdfs"]) {
  const p = join(ROOT, dir);
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
    ok(`created ${dir}/`);
  } else {
    ok(`${dir}/ already exists`);
  }
}

// -----------------------------------------------------------------------
step("Ensuring PWA icons exist (client/public/icons)");
// -----------------------------------------------------------------------
const iconsDir = join(ROOT, "client", "public", "icons");
const requiredIcons = ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"];
const missingIcon = requiredIcons.find((f) => !existsSync(join(iconsDir, f)));
if (missingIcon) {
  info(`missing ${missingIcon} - generating PWA icons from the Laguna logo pattern`);
  const r = run(process.execPath, [join(ROOT, "scripts", "generate-pwa-icons.mjs")]);
  if (r.status !== 0) {
    warn("Could not auto-generate PWA icons. 'Install on Home screen' may fall back to the default browser icon.");
  } else {
    ok("PWA icons generated");
  }
} else {
  ok("PWA icons already present");
}

// -----------------------------------------------------------------------
step("Ensuring .env exists (copied from .env.example if missing)");
// -----------------------------------------------------------------------
const envPath = join(ROOT, ".env");
const envExamplePath = join(ROOT, ".env.example");
if (existsSync(envPath)) {
  ok(".env already exists");
} else if (existsSync(envExamplePath)) {
  copyFileSync(envExamplePath, envPath);
  ok(".env created from .env.example");
} else {
  warn(".env.example missing; create .env manually if you need to override defaults.");
}

// -----------------------------------------------------------------------
console.log("\n============================================");
if (warnings === 0) {
  console.log("  Setup complete. Run:  npm run dev");
} else {
  console.log(`  Setup finished with ${warnings} warning(s) above.`);
  console.log("  You can still try:    npm run dev");
}
console.log("============================================\n");

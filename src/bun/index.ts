/**
 * Marginalia — Electrobun main process.
 * Creates window, menu, tray.
 * Auto-starts Python backend if not already running (for packaged .app).
 */

import { BrowserWindow, ApplicationMenu, Tray } from "electrobun/bun";
import { existsSync } from "fs";
import { join, dirname } from "path";

const BACKEND_PORT = 8765;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

// --- Locate project root ---
function findProjectRoot(): string {
  // Dev mode: traverse up from CWD to find pyproject.toml
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pyproject.toml"))) return dir;
    dir = dirname(dir);
  }
  // Packaged .app: Python code bundled at Contents/Resources/python/
  const bundled = join(process.cwd(), "..", "Resources", "python");
  if (existsSync(join(bundled, "pyproject.toml"))) return bundled;

  return process.cwd();
}

// --- Check if backend is already running (started by start.sh) ---
async function isBackendRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// --- Auto-start backend if needed (for packaged .app without start.sh) ---
let backendProc: ReturnType<typeof Bun.spawn> | null = null;

async function ensureBackend() {
  if (await isBackendRunning()) {
    console.log("[main] Backend already running.");
    return;
  }

  console.log("[main] Backend not running, starting it...");
  const projectRoot = findProjectRoot();

  const uvCandidates = [
    join(process.env.HOME ?? "/", ".local", "bin", "uv"),
    join(process.env.HOME ?? "/", ".cargo", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ];

  let uvBin: string | null = null;
  for (const p of uvCandidates) {
    if (existsSync(p)) { uvBin = p; break; }
  }

  if (!uvBin) {
    console.error("[main] uv not found. Run ./start.sh instead, or install uv.");
    return;
  }

  backendProc = Bun.spawn(
    [uvBin, "run", "uvicorn", "core.server:app",
     "--host", "127.0.0.1", "--port", String(BACKEND_PORT), "--log-level", "warning"],
    {
      cwd: projectRoot,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib" },
    },
  );

  for (let i = 0; i < 40; i++) {
    if (await isBackendRunning()) {
      console.log("[main] Backend ready.");
      return;
    }
    await Bun.sleep(500);
  }
  console.error("[main] Backend failed to start in time.");
}

// --- Cleanup ---
function killBackend() { backendProc?.kill(); }
process.on("SIGINT", () => { killBackend(); process.exit(0); });
process.on("SIGTERM", () => { killBackend(); process.exit(0); });
process.on("exit", killBackend);

// --- Boot ---
await ensureBackend();

// --- UI ---
ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit Marginalia", role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
    ],
  },
]);

const win = new BrowserWindow({
  title: "Marginalia",
  url: "views://mainview/index.html",
  titleBarStyle: "hiddenInset",
  frame: { width: 440, height: 660, x: 100, y: 100 },
});

const tray = new Tray({ title: "Marginalia" });

tray.on("tray-clicked", (e) => {
  const { action } = e.data as { id: number; action: string };
  if (action === "") {
    tray.setMenu([
      { type: "normal", label: "Show / Hide", action: "toggle" },
      { type: "divider" },
      { type: "normal", label: "Quit Marginalia", action: "quit" },
    ]);
  } else if (action === "toggle") {
    win.focus();
  } else if (action === "quit") {
    killBackend();
    process.exit(0);
  }
});

console.log("[main] Marginalia started.");

/**
 * Screen capture and document detection.
 * Delegates to the Python helper (core/get_context.py) which uses macOS Quartz APIs.
 */

import { PROJECT_ROOT, VENV_PYTHON } from "./paths";
import { join } from "path";

const CAPTURE_SCRIPT = join(PROJECT_ROOT, "core", "get_context.py");

export interface ScreenContext {
  doc_info: string;
  page_text: string | null;
  image_b64: string | null;
  app_name: string;
  filename: string | null;
}

export async function captureContext(): Promise<ScreenContext> {
  console.log(`[screen] capturing context via ${CAPTURE_SCRIPT}`);

  const proc = Bun.spawn([VENV_PYTHON, CAPTURE_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib",
    },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    console.error("[screen] capture failed:", stderr);
    return { doc_info: "No document detected", page_text: null, image_b64: null, app_name: "", filename: null };
  }

  try {
    return JSON.parse(stdout.trim());
  } catch {
    console.error("[screen] failed to parse context JSON:", stdout.slice(0, 200));
    return { doc_info: "No document detected", page_text: null, image_b64: null, app_name: "", filename: null };
  }
}

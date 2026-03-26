/**
 * Screen capture and document detection.
 * Delegates to the Python helper (core/get_context.py) which uses macOS Quartz APIs.
 */

import { PROJECT_ROOT, VENV_PYTHON } from "./paths";
import { join } from "path";

const CAPTURE_SCRIPT = join(PROJECT_ROOT, "core", "get_context.py");

export interface CaptureContextOptions {
  includeImage?: boolean;
}

export interface ScreenContext {
  status: "ok" | "no_document" | "unavailable" | "error";
  reason?: string | null;
  doc_info: string;
  page_text: string | null;
  image_b64: string | null;
  app_name: string;
  filename: string | null;
  file_path?: string | null;
  current_page?: number | null;
  total_pages?: number | null;
}

export async function captureContext(options: CaptureContextOptions = {}): Promise<ScreenContext> {
  const includeImage = options.includeImage ?? true;
  console.log(`[screen] capturing context via ${CAPTURE_SCRIPT}`);

  const args = includeImage ? [VENV_PYTHON, CAPTURE_SCRIPT] : [VENV_PYTHON, CAPTURE_SCRIPT, "--no-image"];
  const proc = Bun.spawn(args, {
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
    return {
      status: "error",
      reason: "capture_script_failed",
      doc_info: "Status: error\nDocument capture failed",
      page_text: null,
      image_b64: null,
      app_name: "",
      filename: null,
      file_path: null,
      current_page: null,
      total_pages: null,
    };
  }

  try {
    return JSON.parse(stdout.trim());
  } catch {
    console.error("[screen] failed to parse context JSON:", stdout.slice(0, 200));
    return {
      status: "error",
      reason: "capture_context_invalid_json",
      doc_info: "Status: error\nDocument capture returned invalid JSON",
      page_text: null,
      image_b64: null,
      app_name: "",
      filename: null,
      file_path: null,
      current_page: null,
      total_pages: null,
    };
  }
}

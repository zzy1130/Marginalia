import { join } from "path";
import { PROJECT_ROOT, VENV_PYTHON } from "./paths";

const OBSERVE_SCRIPT = join(PROJECT_ROOT, "core", "desktop_observation.py");

export interface DesktopObservation {
  status: "ok" | "no_window" | "no_document" | "unavailable" | "error";
  reason?: string | null;
  active_window: { app_name: string; title: string };
  activity: { category: string; app: string; title: string; sub?: string };
  window_count: number;
  switch_count_1min: number;
  stay_duration_seconds: number;
  time_context: string;
  recent_activity_summary: Record<string, number>;
  recent_categories: string[];
}

export async function observeDesktop(): Promise<DesktopObservation | null> {
  try {
    const proc = Bun.spawn(
      [VENV_PYTHON, OBSERVE_SCRIPT],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        env: {
          ...(process.env as Record<string, string>),
          DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib",
        },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn(`[desktop-observation] observe failed (${exitCode}): ${stderr.slice(0, 200)}`);
      return null;
    }

    return JSON.parse(stdout.trim()) as DesktopObservation;
  } catch {
    return null;
  }
}

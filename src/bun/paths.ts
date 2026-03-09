/**
 * Resolve the real project root at runtime.
 * When Electrobun bundles the app, import.meta.dir points inside the .app bundle.
 * We traverse upward from CWD to find the actual project root (where pyproject.toml lives).
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pyproject.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();
export const VENV_PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python");

export function loadEnv(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, ".env");
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return vars;
}

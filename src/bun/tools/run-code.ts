/**
 * run_code AgentTool — executes Python code via Bun.spawn with import guards.
 * Port of core/sandbox.py._run_code_fallback to TypeScript.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { VENV_PYTHON, PROJECT_ROOT } from "../paths";

const BLOCKED_MODULES = [
  "subprocess", "socket",
  "ftplib", "smtplib", "multiprocessing",
];

const BLOCKED_SUBMODULES = [
  "http.client", "http.server",
  "urllib.request", "urllib.robotparser",
];

const IMPORT_GUARD = `
# Pre-import libraries and their transitive stdlib dependencies
# BEFORE the import guard activates. Modules cached in sys.modules
# won't trigger the guard on subsequent imports.
import os, sys, re, tempfile, pathlib, importlib
import importlib.metadata, email, email.message, email.utils
import socket as _socket_preload
import fitz, markdown
markdown.Markdown(extensions=["fenced_code", "tables", "nl2br"])
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot
except Exception:
    pass

import builtins as _b
_orig_import = _b.__import__
_BLOCKED = ${JSON.stringify(BLOCKED_MODULES)}
_BLOCKED_SUB = ${JSON.stringify(BLOCKED_SUBMODULES)}
def _safe_import(name, *a, **kw):
    if name.split('.')[0] in _BLOCKED:
        raise ImportError(f'Module {name} is blocked in restricted mode')
    if name in _BLOCKED_SUB:
        raise ImportError(f'Module {name} is blocked in restricted mode')
    return _orig_import(name, *a, **kw)
_b.__import__ = _safe_import
`;

const MAX_TIMEOUT_MS = 30_000;

async function executePython(code: string): Promise<string> {
  const restricted = IMPORT_GUARD + code;

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env["DYLD_LIBRARY_PATH"] = "/opt/homebrew/lib:" + (env["DYLD_LIBRARY_PATH"] ?? "");
  env["DYLD_FALLBACK_LIBRARY_PATH"] = "/opt/homebrew/lib";
  env["MARGINALIA_ROOT"] = PROJECT_ROOT;

  const proc = Bun.spawn([VENV_PYTHON, "-c", restricted], {
    cwd: Bun.env.HOME ?? "/tmp",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timer = setTimeout(() => proc.kill(), MAX_TIMEOUT_MS);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  clearTimeout(timer);

  let output = stdout;
  if (stderr.trim()) output += `\nSTDERR:\n${stderr}`;
  if (exitCode !== 0) output += `\nExit code: ${exitCode}`;
  return output || "(no output)";
}

export const runCodeTool: AgentTool = {
  name: "run_code",
  label: "Run Code",
  description: "Execute Python code. Use code templates from your skills when available.",
  parameters: Type.Object({
    code: Type.String({ description: "Python code to execute." }),
  }),
  execute: async (_toolCallId, params: { code: string }) => {
    try {
      console.log("[run_code] Executing code...");
      const result = await executePython(params.code);
      console.log("[run_code] Result:", result.slice(0, 2000));
      return { content: [{ type: "text", text: result }], details: {} };
    } catch (err) {
      console.error("[run_code] Error:", err);
      throw new Error(`Code execution failed: ${err}`);
    }
  },
};

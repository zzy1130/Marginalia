/**
 * run_code AgentTool factory — creates a Python executor configured
 * by the agent's sandbox settings (blocked modules, timeout).
 *
 * Every agent gets run_code as its sole tool. The sandbox config in
 * AGENT.md controls what each agent's run_code is allowed to do.
 */

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { VENV_PYTHON, PROJECT_ROOT } from "../paths";

export interface RunCodeSandbox {
  blocked_modules?: string[];
  blocked_submodules?: string[];
  max_timeout_s?: number;
}

const DEFAULT_BLOCKED = [
  "subprocess", "socket",
  "ftplib", "smtplib", "multiprocessing",
];

const DEFAULT_BLOCKED_SUBMODULES = [
  "http.client", "http.server",
  "urllib.request", "urllib.robotparser",
];

function buildImportGuard(blocked: string[], blockedSub?: string[]): string {
  const submodules = blockedSub ?? DEFAULT_BLOCKED_SUBMODULES;
  return `
import os, sys, re, tempfile, pathlib, importlib
import importlib.metadata, email, email.message, email.utils
import socket as _socket_preload

# Project root on sys.path so skills can import from core.*
_mr = os.environ.get("MARGINALIA_ROOT", ".")
if _mr not in sys.path:
    sys.path.insert(0, _mr)

try:
    import fitz
except ImportError:
    pass
try:
    import markdown
    markdown.Markdown(extensions=["fenced_code", "tables", "nl2br"])
except ImportError:
    pass
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot
except ImportError:
    pass

import builtins as _b
_orig_import = _b.__import__
_BLOCKED = ${JSON.stringify(blocked)}
_BLOCKED_SUB = ${JSON.stringify(submodules)}
def _safe_import(name, *a, **kw):
    if name.split('.')[0] in _BLOCKED:
        raise ImportError(f'Module {name} is blocked in restricted mode')
    if name in _BLOCKED_SUB:
        raise ImportError(f'Module {name} is blocked in restricted mode')
    return _orig_import(name, *a, **kw)
_b.__import__ = _safe_import
`;
}

async function executePython(code: string, importGuard: string, timeoutMs: number): Promise<string> {
  const restricted = importGuard + code;

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

  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  clearTimeout(timer);

  let output = stdout;
  if (stderr.trim()) output += `\nSTDERR:\n${stderr}`;
  if (exitCode !== 0) output += `\nExit code: ${exitCode}`;
  return output || "(no output)";
}

export function createRunCodeTool(sandbox?: RunCodeSandbox): AgentTool {
  const blocked = sandbox?.blocked_modules ?? DEFAULT_BLOCKED;
  const blockedSub = sandbox?.blocked_submodules;
  const timeoutMs = (sandbox?.max_timeout_s ?? 30) * 1000;
  const importGuard = buildImportGuard(blocked, blockedSub);

  console.log(`[run_code] Sandbox: blocked=[${blocked.join(",")}], timeout=${timeoutMs}ms`);

  return {
    name: "run_code",
    label: "Run Code",
    description: "Execute Python code. Use code templates from your skills when available.",
    parameters: Type.Object({
      code: Type.String({ description: "Python code to execute." }),
    }),
    execute: async (_toolCallId, params: unknown) => {
      try {
        const { code } = params as { code: string };
        console.log("[run_code] Executing code...");
        const result = await executePython(code, importGuard, timeoutMs);
        console.log("[run_code] Result:", result.slice(0, 2000));
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (err) {
        console.error("[run_code] Error:", err);
        throw new Error(`Code execution failed: ${err}`);
      }
    },
  };
}

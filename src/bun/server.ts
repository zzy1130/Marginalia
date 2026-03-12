/**
 * Bun HTTP server — multi-agent backend.
 * Serves /health, /api/chat (SSE), /api/terminal-events (SSE), /api/agents.
 *
 * Terminal polling runs in the background and pushes alerts to connected
 * /api/terminal-events clients.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model, Message, UserMessage, TextContent, ImageContent } from "@mariozechner/pi-ai";
import { loadAgent } from "./kernel";
import { loadEnv, VENV_PYTHON, PROJECT_ROOT } from "./paths";
import { captureContext } from "./screen";
import { buildTools } from "./tools/registry";
import { selectAgent, listAgents } from "./router";
import { join } from "path";

const BACKEND_PORT = 8765;
const TERMINAL_POLL_MS = 3_000;
const TERMINAL_SCRIPT = join(PROJECT_ROOT, "core", "terminal.py");

const env = loadEnv();
const API_KEY = env.ANTHROPIC_API_KEY ?? Bun.env.ANTHROPIC_API_KEY ?? "";
const BASE_URL = env.ANTHROPIC_BASE_URL ?? Bun.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MODEL_ID = env.MODEL ?? Bun.env.MODEL ?? "qwen3.5-plus";

function makeModel(modelId: string): Model<"anthropic-messages"> {
  return {
    id: modelId,
    name: `${modelId} (DashScope)`,
    api: "anthropic-messages",
    provider: "dashscope",
    baseUrl: BASE_URL,
    headers: { Authorization: `Bearer ${API_KEY}` },
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

// ── Agent sessions ───────────────────────────────────────────────
//
// Each agent gets a persistent Agent instance that accumulates
// conversation history across requests. Switching agents keeps
// each session alive independently.

const sessions = new Map<string, Agent>();

function newAgent(agentId: string): Agent {
  const meta = loadAgent(agentId);
  const tools = buildTools(meta.tools ?? [], meta.sandbox);
  const model = makeModel(meta.model ?? MODEL_ID);

  return new Agent({
    initialState: {
      systemPrompt: meta.system_prompt,
      model,
      tools,
    },
    getApiKey: () => API_KEY,
    convertToLlm: (messages: AgentMessage[]) =>
      messages.filter(
        (m): m is Message =>
          "role" in m &&
          ["user", "assistant", "toolResult"].includes((m as Message).role),
      ),
  });
}

function getAgent(agentId: string): Agent {
  let agent = sessions.get(agentId);
  if (!agent) {
    agent = newAgent(agentId);
    sessions.set(agentId, agent);
    console.log(`[session] New session: ${agentId}`);
  }
  return agent;
}

function resetSession(agentId?: string) {
  if (agentId) {
    sessions.delete(agentId);
    console.log(`[session] Reset: ${agentId}`);
  } else {
    sessions.clear();
    console.log(`[session] Reset all`);
  }
}

// ── /api/chat handler ────────────────────────────────────────────

async function handleChat(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const prompt: string = body.text ?? "";
  const requestedAgent: string | undefined = body.agentId;
  const terminalContext: any = body.terminalContext;

  let agentId: string;
  const content: (TextContent | ImageContent)[] = [];

  if (requestedAgent) {
    agentId = requestedAgent;
    const meta = loadAgent(agentId);

    if (meta.sandbox?.can_capture_screen !== false) {
      const screenCtx = await captureContext();
      content.push({ type: "text", text: `[Current document info]\n${screenCtx.doc_info}` });
      if (screenCtx.page_text) {
        content.push({ type: "text", text: `[Page content (extracted text)]\n${screenCtx.page_text}` });
      }
      if (screenCtx.image_b64) {
        content.push({ type: "image", data: screenCtx.image_b64, mimeType: "image/jpeg" });
      }
    }
  } else {
    const screenCtx = await captureContext();
    agentId = selectAgent(screenCtx.app_name, screenCtx.filename ?? undefined);

    content.push({ type: "text", text: `[Current document info]\n${screenCtx.doc_info}` });
    if (screenCtx.page_text) {
      content.push({ type: "text", text: `[Page content (extracted text)]\n${screenCtx.page_text}` });
    }
    if (screenCtx.image_b64) {
      content.push({ type: "image", data: screenCtx.image_b64, mimeType: "image/jpeg" });
    }
  }

  if (terminalContext) {
    resetSession("terminal_helper");
    const src = terminalContext.source === "cursor" ? "Cursor" : terminalContext.source === "iterm2" ? "iTerm2" : "Terminal.app";
    content.push({
      type: "text",
      text: [
        `[你正在回复这个终端，直接用 type-in-terminal skill 发送消息，不需要再扫描]`,
        `终端来源: ${src}`,
        `终端ID: ${terminalContext.id}`,
        `命令: ${terminalContext.command || "unknown"}`,
        terminalContext.summary ? `AI agent最新回复: ${terminalContext.summary}` : "",
      ].filter(Boolean).join("\n"),
    });
  }

  content.push({ type: "text", text: prompt });
  return streamAgentResponse(agentId, { role: "user", content, timestamp: Date.now() });
}

function streamAgentResponse(agentId: string, userMessage: UserMessage): Response {
  const agent = getAgent(agentId);
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController | null = null;

  function emit(type: string, data: string) {
    if (!streamController) return;
    try {
      const event = JSON.stringify({ type, data });
      streamController.enqueue(encoder.encode(`data: ${event}\n\n`));
    } catch { /* stream closed */ }
  }

  let textAccum = "";

  agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        emit("status", "Thinking...");
        emit("agent_id", agentId);
        break;

      case "message_update":
        if ("assistantMessageEvent" in event) {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            textAccum += ame.delta;
          }
        }
        break;

      case "message_end":
        if (textAccum) {
          emit("text", textAccum);
          textAccum = "";
        }
        break;

      case "tool_execution_start":
        if ("toolName" in event) {
          emit("status", `Running: ${event.toolName}...`);
        }
        break;

      case "agent_end":
        emit("done", "");
        try { streamController?.close(); } catch { /* already closed */ }
        break;
    }
  });

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;

      console.log(`[server] agent.prompt() → ${agentId}`);
      agent.prompt(userMessage).catch((err) => {
        console.error("[server] agent.prompt() error:", err);
        emit("error", String(err));
        try { controller.close(); } catch { /* closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Terminal polling + SSE ───────────────────────────────────────
//
// Polls terminal.py status every TERMINAL_POLL_MS.
// Tracks state per terminal and fires two event types:
//   terminal_alert     — an active terminal needs human decision
//   terminal_completed — a previously-active terminal finished its task

let terminalClients: ReadableStreamDefaultController[] = [];
const encoder = new TextEncoder();

interface TermPrev {
  active: boolean;
  command: string;
  lastPrompt: string;
  tailHash: string;
  stableCount: number;
  wasGenerating: boolean;
}
const prevStates = new Map<string, TermPrev>();

function hashTail(tail: string): string {
  return `${tail.length}:${tail.slice(-200)}`;
}

function pushToClients(payload: { type: string; data: any }) {
  const before = terminalClients.length;
  const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  terminalClients = terminalClients.filter((c) => {
    try { c.enqueue(chunk); return true; } catch { return false; }
  });
  console.log(`[push] ${payload.type} → ${terminalClients.length}/${before} clients`);
}

// ── LLM summarization ───────────────────────────────────────────

const FAST_MODEL = "qwen3.5-flash";

async function callLLM(system: string, user: string): Promise<string> {
  const url = `${BASE_URL}/v1/messages`;
  console.log(`[summarize] Calling ${url} with model=${FAST_MODEL}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`[summarize] API ${res.status}: ${body.slice(0, 500)}`);
      return "";
    }
    const data = JSON.parse(body);
    const textBlock = Array.isArray(data.content)
      ? data.content.find((b: any) => b.type === "text")
      : null;
    const text = textBlock?.text
      ?? data.choices?.[0]?.message?.content
      ?? "";
    if (!text) {
      console.error(`[summarize] Empty text. body: ${body.slice(0, 400)}`);
    } else {
      console.log(`[summarize] OK: ${text.slice(0, 150)}`);
    }
    return text;
  } catch (err) {
    console.error("[summarize] Error:", err);
    return "";
  }
}

let eventSeq = 0;

function fireTerminalEvent(eventType: string, termData: any) {
  const seq = ++eventSeq;
  const src = termData.source === "cursor" ? "Cursor终端" : termData.source === "iterm2" ? "iTerm2" : "Terminal.app";

  // Push immediately with a placeholder
  console.log(`[event #${seq}] ${eventType}: ${src} — requesting summary...`);
  pushToClients({
    type: eventType,
    data: { ...termData, summary: `${src} 有新回复，正在提取...`, eventSeq: seq },
  });

  // Fire LLM to extract actual response, then update
  const content = (termData.content ?? termData.tail ?? "").slice(-2000);

  const system = eventType === "terminal_alert"
    ? "从终端输出中提取AI agent正在等待的问题或决策。只返回原文，1-3行。"
    : `从以下终端输出中，找到AI agent最后一次回复的完整原文并返回。

要求：
- 返回完整回复，不要只返回最后一行
- 跳过用户输入的短句（如"你好"、"hi"等）
- 跳过英文的thinking/推理段落（如 "The user is..." "I should..."）
- 跳过终端装饰（分隔线───、路径~/...、状态栏↑↓等）
- 直接返回原文，不加任何前缀或解释`;

  callLLM(system, content).then((extracted) => {
    if (extracted) {
      console.log(`[event #${seq}] Summary ready: ${extracted.slice(0, 80)}`);
      pushToClients({
        type: "terminal_update",
        data: { eventSeq: seq, summary: extracted },
      });
    }
  });
}

let pollCount = 0;
let pollRunning = false;

async function pollTerminals() {
  if (pollRunning) return;
  pollRunning = true;
  pollCount++;
  const isVerbose = pollCount <= 5 || pollCount % 20 === 0;

  if (terminalClients.length === 0) {
    pollRunning = false;
    return;
  }

  if (isVerbose) {
    console.log(`[terminal-poll #${pollCount}] Starting scan...`);
  }

  try {
    const proc = Bun.spawn([VENV_PYTHON, TERMINAL_SCRIPT, "status"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        DYLD_FALLBACK_LIBRARY_PATH: "/opt/homebrew/lib",
      },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`[terminal-poll #${pollCount}] Python exited ${exitCode}: ${stderr.slice(0, 500)}`);
      return;
    }

    let terminals: any[];
    try {
      terminals = JSON.parse(stdout);
    } catch (e) {
      console.error(`[terminal-poll #${pollCount}] JSON parse failed: ${stdout.slice(0, 300)}`);
      return;
    }
    if (!Array.isArray(terminals)) {
      console.error(`[terminal-poll #${pollCount}] Not an array: ${typeof terminals}`);
      return;
    }

    if (isVerbose) {
      const summary = terminals.map((t: any) =>
        `${t.id?.split(":").pop()}(${t.active ? "active" : "idle"},ai=${t.is_ai})`
      ).join(" ");
      console.log(`[terminal-poll #${pollCount}] ${terminals.length} terminals: ${summary} | SSE clients: ${terminalClients.length}`);
    }

    // Push active AI terminal list for tab discovery
    if (pollCount <= 3 || pollCount % 10 === 0) {
      const aiTerminals = terminals.filter((t: any) => t.is_ai && t.active);
      if (aiTerminals.length > 0) {
        pushToClients({
          type: "terminal_list",
          data: aiTerminals.map((t: any) => ({
            id: t.id, source: t.source, name: t.name, command: t.command,
          })),
        });
      }
    }

    for (const term of terminals) {
      const id: string = term.id;
      const prev = prevStates.get(id);
      const isActive = !!term.active;
      const command = term.command ?? "";
      const curTail: string = term.tail ?? "";
      const curHash = hashTail(curTail);

      const base: TermPrev = {
        active: isActive,
        command: isActive ? command : (prev?.command ?? command),
        lastPrompt: prev?.lastPrompt ?? "",
        tailHash: curHash,
        stableCount: 0,
        wasGenerating: false,
      };

      // ── Event 1: needs input ──
      if (term.needs_input) {
        const fingerprint = `${id}::${term.prompt}`;
        if (!prev || prev.lastPrompt !== fingerprint) {
          console.log(`[terminal-poll #${pollCount}] >>> ALERT: ${term.source}:${id} — "${term.prompt}"`);
          fireTerminalEvent("terminal_alert", term);
          prevStates.set(id, { ...base, lastPrompt: fingerprint });
          continue;
        }
      }

      // ── Event 2: process exit (active → inactive) ──
      if (prev && prev.active && !isActive) {
        console.log(`[terminal-poll #${pollCount}] >>> COMPLETED: ${term.source}:${id} — cmd="${prev.command}"`);
        fireTerminalEvent("terminal_completed", { ...term, command: prev.command });
        prevStates.set(id, base);
        continue;
      }

      // ── Event 3: REPL response (output changed then stabilized) ──
      if (isActive && prev && term.is_ai) {
        const changed = curHash !== prev.tailHash;
        const curTail: string = term.tail ?? "";
        const prevTail: string = prev.tailHash ? (prev as any)._tailContent ?? "" : "";
        const lenDiff = Math.abs(curTail.length - prevTail.length);
        const significantChange = changed && lenDiff > 50;

        if (significantChange) {
          if (!prev.wasGenerating) {
            console.log(`[terminal-poll #${pollCount}] ${id} output changing (+${lenDiff} chars)...`);
          }
          prevStates.set(id, { ...base, wasGenerating: true, _tailContent: curTail } as any);
        } else if (prev.wasGenerating) {
          const stable = prev.stableCount + 1;
          if (stable >= 2) {
            console.log(`[terminal-poll #${pollCount}] >>> RESPONSE DONE: ${term.source}:${id}`);
            fireTerminalEvent("terminal_completed", term);
            prevStates.set(id, { ...base, _tailContent: curTail } as any);
          } else {
            prevStates.set(id, { ...base, wasGenerating: true, stableCount: stable, _tailContent: curTail } as any);
          }
        } else {
          prevStates.set(id, { ...base, _tailContent: curTail } as any);
        }
      } else {
        prevStates.set(id, { ...base, _tailContent: term.tail ?? "" } as any);
      }
    }
  } catch (err) {
    console.error(`[terminal-poll #${pollCount}] Exception:`, err);
  } finally {
    pollRunning = false;
  }
}

function handleTerminalEvents(): Response {
  let ctrl: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      terminalClients.push(controller);
      controller.enqueue(encoder.encode(":ok\n\n"));
      console.log(`[sse] Client connected. Total: ${terminalClients.length}`);
    },
    cancel() {
      terminalClients = terminalClients.filter((c) => c !== ctrl);
      console.log(`[sse] Client disconnected. Total: ${terminalClients.length}`);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Server ───────────────────────────────────────────────────────

export function startServer() {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  Bun.serve({
    port: BACKEND_PORT,
    async fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json(
          { status: "ok", agents: listAgents() },
          { headers: corsHeaders },
        );
      }

      if (url.pathname === "/api/agents") {
        return Response.json(listAgents(), { headers: corsHeaders });
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        return handleChat(req);
      }

      if (url.pathname === "/api/reset" && req.method === "POST") {
        return req.json().then((b: any) => {
          resetSession(b?.agentId);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }).catch(() => {
          resetSession();
          return Response.json({ ok: true }, { headers: corsHeaders });
        });
      }

      if (url.pathname === "/api/terminal-events") {
        return handleTerminalEvents();
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[server] Listening on http://127.0.0.1:${BACKEND_PORT}`);
  console.log(`[server] Terminal polling every ${TERMINAL_POLL_MS / 1000}s`);
  console.log(`[server] VENV_PYTHON=${VENV_PYTHON}`);
  console.log(`[server] TERMINAL_SCRIPT=${TERMINAL_SCRIPT}`);

  // First poll immediately, then periodic
  setTimeout(pollTerminals, 500);
  setInterval(pollTerminals, TERMINAL_POLL_MS);
}

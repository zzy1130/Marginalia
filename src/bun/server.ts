/**
 * Bun HTTP server — replaces Python FastAPI backend.
 * Serves /health and /api/chat (SSE) using pi-mono Agent.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model, Message, UserMessage, TextContent, ImageContent } from "@mariozechner/pi-ai";
import { loadSkill } from "./kernel";
import { loadEnv } from "./paths";
import { captureContext } from "./screen";
import { runCodeTool } from "./tools/run-code";

const BACKEND_PORT = 8765;

const env = loadEnv();
const API_KEY = env.ANTHROPIC_API_KEY ?? Bun.env.ANTHROPIC_API_KEY ?? "";
const BASE_URL = env.ANTHROPIC_BASE_URL ?? Bun.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MODEL_ID = env.MODEL ?? Bun.env.MODEL ?? "qwen3.5-plus";

const dashscopeModel: Model<"anthropic-messages"> = {
  id: MODEL_ID,
  name: `${MODEL_ID} (DashScope)`,
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

function createAgent(): Agent {
  const skill = loadSkill();

  return new Agent({
    initialState: {
      systemPrompt: skill.system_prompt,
      model: dashscopeModel,
      tools: [runCodeTool],
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

async function handleChat(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const prompt: string = body.text ?? "";

  const agent = createAgent();
  const screenCtx = await captureContext();

  const content: (TextContent | ImageContent)[] = [];
  content.push({ type: "text", text: `[Current document info]\n${screenCtx.doc_info}` });
  if (screenCtx.page_text) {
    content.push({ type: "text", text: `[Page content (extracted text)]\n${screenCtx.page_text}` });
  }
  if (screenCtx.image_b64) {
    content.push({ type: "image", data: screenCtx.image_b64, mimeType: "image/jpeg" });
  }
  content.push({ type: "text", text: prompt });

  const userMessage: UserMessage = {
    role: "user",
    content,
    timestamp: Date.now(),
  };

  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController | null = null;

  function emit(type: string, data: string) {
    if (!streamController) return;
    try {
      const event = JSON.stringify({ type, data });
      streamController.enqueue(encoder.encode(`data: ${event}\n\n`));
    } catch { /* stream already closed */ }
  }

  let textAccum = "";

  agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        emit("status", "🧠 Thinking...");
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
          emit("status", `⚙️ Running: ${event.toolName}...`);
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
      emit("status", "📄 Reading current page...");

      console.log("[server] Starting agent.prompt()...");
      agent.prompt(userMessage).catch((err) => {
        console.error("[server] agent.prompt() error:", err);
        emit("error", String(err));
        try { controller.close(); } catch { /* already closed */ }
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

export function startServer() {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  Bun.serve({
    port: BACKEND_PORT,
    fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", sandbox: "available" }, { headers: corsHeaders });
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        return handleChat(req);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[server] Listening on http://127.0.0.1:${BACKEND_PORT}`);
}

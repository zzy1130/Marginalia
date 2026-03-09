/**
 * Anthropic-compatible API client with tool use for Marginalia.
 * Uses DashScope's Anthropic-compatible endpoint via direct fetch.
 */

import { PROJECT_ROOT, VENV_PYTHON, loadEnv } from "./paths";
import type { ScreenContext } from "./screen";

const env = loadEnv();
const API_KEY = env.ANTHROPIC_API_KEY ?? Bun.env.ANTHROPIC_API_KEY ?? "";
const BASE_URL = env.ANTHROPIC_BASE_URL ?? Bun.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MODEL = env.MODEL ?? Bun.env.MODEL ?? "qwen3.5-plus";

const SYSTEM_PROMPT = `\
You are Marginalia, an intelligent learning companion. The user is studying from \
PDF or PPT course slides. You help them understand content and take notes.

## Your capabilities
1. **See the current page**: The user's screen context (screenshot + document info) \
is automatically attached to each message. You can see the page content directly.
2. **Explain content**: Answer questions about the page clearly, in the user's language \
(default: Chinese).
3. **Take notes into the file**: Use \`insert_notes\` tool to insert notes into PDF/PPT.

## CRITICAL: How to take notes

Use the \`insert_notes\` tool. Provide:
1. **markdown_content**: Notes in Markdown (headings, bold, lists, tables, blockquotes, code)
2. **file_path**: Absolute path from document context
3. **page_number**: 1-based page number from document context. Notes are inserted AFTER this page.

### Symbol formatting rules — MANDATORY:
- **EVERY mathematical symbol MUST use LaTeX** with \`$...$\`. NO EXCEPTIONS.
- NEVER write plain text like "C_obs", "C-free", "A(q)". ALWAYS write \`$\\mathcal{C}_{\\text{obs}}$\`, \`$\\mathcal{C}_{\\text{free}}$\`, \`$\\mathcal{A}(q)$\`.
- Even single variables must use LaTeX: write \`$q$\` not "q", write \`$\\mathcal{C}$\` not "C".
- For display (block) math, use \`$$...$$\`.
- **Match the original slide's notation exactly** — use the same symbols you see.
- Examples:
  - \`$\\mathcal{C}_{\\text{obs}}$\` for C_obs
  - \`$\\mathcal{A}(q) \\subset \\mathbb{R}^3$\` for A(q) ⊂ R^3
  - \`$q \\in \\mathcal{C}$\` for q ∈ C
  - \`$$\\mathcal{C}_{\\text{obs}} = \\{q \\in \\mathcal{C} \\mid \\mathcal{A}(q) \\cap \\mathcal{O} \\neq \\emptyset\\}$$\` for display formulas

### Note quality rules — THIS IS THE MOST IMPORTANT PART:
Your notes must help the student UNDERSTAND and LEARN, not just repeat the slide.

**DO NOT** just translate or rephrase the slide content. That is useless.

**DO** write notes that:
- **Explain the intuition**: WHY does this concept exist? What problem does it solve?
- **Use analogies**: Compare abstract concepts to everyday things the student already knows.
- **Highlight what's non-obvious**: What would confuse a student? Clarify those points.
- **Show the reasoning chain**: How do concepts connect? What leads to what?
- **Add "aha" insights**: The kind of understanding you'd get from a great teacher, not a textbook.

Example of BAD notes (no LaTeX, just restating the slide):
"C_obs = {q in C | A(q) ∩ O ≠ ∅}, C_free = C \\ C_obs"

Example of GOOD notes (uses LaTeX, explains intuition):
"**Why do we need $\\mathcal{C}_{\\text{obs}}$?** Imagine you're planning a robot arm's movement. In the real world (workspace),
checking if the arm hits something is complicated — the arm has many links, each sweeps a different volume.
$\\mathcal{C}_{\\text{obs}}$ transforms this 3D geometry problem into a simpler question: is this single POINT ($q$)
inside the forbidden region or not? The key formula:
$$\\mathcal{C}_{\\text{obs}} = \\{q \\in \\mathcal{C} \\mid \\mathcal{A}(q) \\cap \\mathcal{O} \\neq \\emptyset\\}$$
The trade-off: $\\mathcal{C}_{\\text{obs}}$ is hard to compute explicitly (you can't draw its
boundary), but you CAN test individual points — this is the 'membership oracle' idea."

### Format rules:
- **ONE A4 page max** — be concise but insightful (~250 words).
- Use \`insert_notes\` tool — never generate HTML/PDF code manually.
- **page_number is 1-based** — use directly from document context.

## Rules
- Always respond in the same language as the user (Chinese if they speak Chinese).
- When explaining, break down complex concepts step by step.
- Write notes that teach, not just summarize.
`;

const TOOLS = [
  {
    name: "insert_notes",
    description:
      "Insert beautifully formatted study notes into the PDF/PPTX file. " +
      "Write notes in Markdown format — the system handles HTML/CSS/PDF rendering automatically. " +
      "Supports headings, bold, lists, tables, blockquotes, code blocks.",
    input_schema: {
      type: "object",
      properties: {
        markdown_content: {
          type: "string",
          description: "The notes content in Markdown format (Chinese or English).",
        },
        file_path: {
          type: "string",
          description: "Absolute path to the PDF or PPTX file.",
        },
        page_number: {
          type: "integer",
          description: "1-based page number (same as shown in document context). Notes will be inserted AFTER this page.",
        },
      },
      required: ["markdown_content", "file_path", "page_number"],
    },
  },
  {
    name: "run_code",
    description:
      "Run a Python script for other file modifications (e.g. add annotations). " +
      "For inserting notes, prefer insert_notes tool instead.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute." },
      },
      required: ["code"],
    },
  },
];

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: { type: string; media_type: string; data: string };
}

interface ApiResponse {
  content: ContentBlock[];
  stop_reason: string;
}

function makeProcEnv(): Record<string, string> {
  const procEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  procEnv["DYLD_LIBRARY_PATH"] = "/opt/homebrew/lib:" + (procEnv["DYLD_LIBRARY_PATH"] ?? "");
  procEnv["DYLD_FALLBACK_LIBRARY_PATH"] = "/opt/homebrew/lib";
  return procEnv;
}

async function executeCode(code: string): Promise<string> {
  const proc = Bun.spawn([VENV_PYTHON, "-c", code], {
    cwd: Bun.env.HOME ?? "/",
    stdout: "pipe",
    stderr: "pipe",
    env: makeProcEnv(),
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  let output = stdout;
  if (stderr) output += `\nSTDERR:\n${stderr}`;
  if (exitCode !== 0) output += `\nExit code: ${exitCode}`;
  return output || "(no output)";
}

async function insertNotes(
  markdownContent: string,
  filePath: string,
  pageIndex: number,
): Promise<string> {
  // Call Python's _insert_notes function which uses PyMuPDF Story API
  // Write markdown to a temp file to avoid shell escaping issues
  const tmpMd = `/tmp/marginalia_md_${Date.now()}.md`;
  await Bun.write(tmpMd, markdownContent);

  const code = `
import sys, os
sys.path.insert(0, "${PROJECT_ROOT}")
with open("${tmpMd}", "r", encoding="utf-8") as f:
    md_content = f.read()
os.remove("${tmpMd}")
from core.agent import _insert_notes
result = _insert_notes(md_content, "${filePath}", ${pageIndex})
print(result)
`;

  const proc = Bun.spawn([VENV_PYTHON, "-c", code], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: makeProcEnv(),
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return `Insert notes failed:\n${stderr}\n${stdout}`;
  }
  return stdout.trim() || "Notes inserted successfully!";
}

function buildUserContent(prompt: string, screenCtx: ScreenContext | null): ContentBlock[] {
  const content: ContentBlock[] = [];

  if (screenCtx) {
    content.push({ type: "text", text: `[Current document info]\n${screenCtx.doc_info}` });

    if (screenCtx.page_text) {
      content.push({
        type: "text",
        text: `[Page content (extracted text)]\n${screenCtx.page_text}`,
      });
    }

    if (screenCtx.image_b64) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: screenCtx.image_b64,
        },
      });
    }
  }

  content.push({ type: "text", text: prompt });
  return content;
}

export type StreamCallback = (type: "status" | "text" | "done" | "error", data: string) => void;

export async function runQuery(
  prompt: string,
  history: any[],
  screenCtx: ScreenContext | null,
  callback: StreamCallback,
): Promise<void> {
  const messages = [...history];

  callback("status", "📄 Reading current page...");
  const userContent = buildUserContent(prompt, screenCtx);
  messages.push({ role: "user", content: userContent });

  const maxIterations = 10;

  try {
    for (let i = 0; i < maxIterations; i++) {
      callback("status", "🧠 Thinking...");
      console.log(`[agent] request to ${MODEL} (iteration ${i + 1})`);

      const response = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        callback("error", `API error ${response.status}: ${errText}`);
        return;
      }

      const data: ApiResponse = await response.json();

      const textParts: string[] = [];
      const toolBlocks: ContentBlock[] = [];

      for (const block of data.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolBlocks.push(block);
        }
      }

      if (textParts.length > 0) {
        callback("text", textParts.join("\n"));
      }

      if (data.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: data.content });

      const toolResults: any[] = [];
      for (const tool of toolBlocks) {
        callback("status", `⚙️ Running: ${tool.name}...`);
        console.log(`[agent] executing tool: ${tool.name}`);
        const input = tool.input as Record<string, unknown>;
        let result: string;

        if (tool.name === "insert_notes") {
          const pageNumber = (input.page_number as number) ?? 1;
          const pageIndex = Math.max(0, pageNumber - 1); // 1-based → 0-based
          result = await insertNotes(
            (input.markdown_content as string) ?? "",
            (input.file_path as string) ?? "",
            pageIndex,
          );
        } else {
          result = await executeCode((input.code as string) ?? "");
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: [{ type: "text", text: result }],
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    callback("done", "");
  } catch (err) {
    console.error("[agent] error:", err);
    callback("error", String(err));
  }
}

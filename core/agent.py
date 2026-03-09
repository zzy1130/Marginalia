"""Anthropic SDK agent with tool use for Marginalia."""

import base64
import os
import tempfile
from typing import AsyncGenerator, Optional

from dotenv import dotenv_values
import anthropic
import httpx

from core.screen import get_document_context, capture_window

# Load config
_config = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))

SYSTEM_PROMPT = """\
You are Marginalia, an intelligent learning companion. The user is studying from \
PDF or PPT course slides. You help them understand content and take notes.

## Your capabilities
1. **See the current page**: The user's screen context (screenshot + document info) \
is automatically attached to each message. You can see the page content directly.
2. **Explain content**: Answer questions about the page clearly, in the user's language \
(default: Chinese).
3. **Take notes into the file**: Use `insert_notes` tool to insert notes into PDF/PPT.

## CRITICAL: How to take notes

Use the `insert_notes` tool. Provide:
1. **markdown_content**: Notes in Markdown (headings, bold, lists, tables, blockquotes, code)
2. **file_path**: Absolute path from document context
3. **page_number**: 1-based page number from document context. Notes are inserted AFTER this page.

### Symbol formatting rules — MANDATORY:
- **EVERY mathematical symbol MUST use LaTeX** with `$...$`. NO EXCEPTIONS.
- NEVER write plain text like "C_obs", "C-free", "A(q)". ALWAYS write `$\\mathcal{C}_{\\text{obs}}$`, `$\\mathcal{C}_{\\text{free}}$`, `$\\mathcal{A}(q)$`.
- Even single variables must use LaTeX: write `$q$` not "q", write `$\\mathcal{C}$` not "C".
- For display (block) math, use `$$...$$`.
- **Match the original slide's notation exactly** — use the same symbols you see.
- Examples:
  - `$\\mathcal{C}_{\\text{obs}}$` for C_obs
  - `$\\mathcal{A}(q) \\subset \\mathbb{R}^3$` for A(q) ⊂ R^3
  - `$q \\in \\mathcal{C}$` for q ∈ C
  - `$$\\mathcal{C}_{\\text{obs}} = \\{q \\in \\mathcal{C} \\mid \\mathcal{A}(q) \\cap \\mathcal{O} \\neq \\emptyset\\}$$` for display formulas

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
"C_obs = {q in C | A(q) ∩ O ≠ ∅}, C_free = C \\\\ C_obs"

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
- Use `insert_notes` tool — never generate HTML/PDF code manually.
- **page_number is 1-based** — use directly from document context.

## Rules
- Always respond in the same language as the user (Chinese if they speak Chinese).
- When explaining, break down complex concepts step by step.
- When taking notes, ask the user whether they want a sticky annotation or a new page.
- Write high-quality, well-organized notes with clear headings, tables, and structure.
"""

TOOLS = [
    {
        "name": "insert_notes",
        "description": (
            "Insert beautifully formatted study notes into the PDF/PPTX file. "
            "Write notes in Markdown format — the system handles HTML/CSS/PDF rendering automatically. "
            "Supports headings, bold, lists, tables, blockquotes, code blocks."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "markdown_content": {
                    "type": "string",
                    "description": "The notes content in Markdown format (Chinese or English).",
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the PDF or PPTX file.",
                },
                "page_number": {
                    "type": "integer",
                    "description": "1-based page number (same as shown in document context). Notes will be inserted AFTER this page.",
                },
            },
            "required": ["markdown_content", "file_path", "page_number"],
        },
    },
    {
        "name": "run_code",
        "description": (
            "Run a Python script for other file modifications (e.g. add annotations). "
            "For inserting notes, prefer insert_notes tool instead."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute.",
                }
            },
            "required": ["code"],
        },
    },
]


_VENV_PYTHON = os.path.join(os.path.dirname(__file__), "..", ".venv", "bin", "python")

_NOTES_CSS = """\
body {
  font-family: sans-serif;
  font-size: 10px; color: #222; line-height: 1.6;
}
h1 {
  font-size: 17px; font-weight: bold; color: #2E4226;
  border-bottom: 2px solid #2E4226; padding-bottom: 6px;
  margin-bottom: 10px;
}
h2 {
  font-size: 12px; font-weight: bold; color: #2E4226;
  margin-top: 12px; margin-bottom: 5px; padding-bottom: 3px;
  border-bottom: 1px solid #d4ddd0;
}
h3 { font-size: 11px; font-weight: bold; color: #55644A; margin-top: 8px; margin-bottom: 4px; }
p { margin-top: 3px; margin-bottom: 3px; }
ul, ol { padding-left: 18px; margin-top: 4px; margin-bottom: 4px; }
li { margin-top: 1px; margin-bottom: 1px; }
b, strong { font-weight: bold; color: #1a3a10; }
code {
  background-color: #f0f0f0; padding: 1px 4px;
  font-family: monospace; font-size: 9px;
}
pre {
  background-color: #f7f8f6; padding: 10px 12px;
  border: 1px solid #e4e8e2; font-size: 9px;
  font-family: monospace; line-height: 1.5;
}
blockquote {
  border-left: 3px solid #2E4226; padding: 5px 10px;
  background-color: #f2f6ef; color: #333; font-style: italic;
  margin-top: 6px; margin-bottom: 6px;
}
table { border-collapse: collapse; margin-top: 6px; margin-bottom: 6px; }
th {
  font-weight: bold; text-align: left; padding: 4px 8px;
  border: 1px solid #d4ddd0; font-size: 9px; color: #2E4226;
  background-color: #eef3eb;
}
td { padding: 3px 8px; border: 1px solid #dde3da; font-size: 9px; }
hr { border: none; border-top: 1px solid #e0e0e0; margin-top: 8px; margin-bottom: 8px; }
"""


async def _execute_tool(name: str, tool_input: dict) -> list:
    """Execute a tool via sandbox and return content blocks for the tool_result."""
    from core.sandbox import get_sandbox_manager

    mgr = get_sandbox_manager()

    if name == "insert_notes":
        try:
            md_content = tool_input.get("markdown_content", "")
            file_path = tool_input.get("file_path", "")
            page_number = tool_input.get("page_number", 1)
            page_index = max(0, page_number - 1)
            result = await mgr.run_insert_notes(md_content, file_path, page_index)
            return [{"type": "text", "text": result}]
        except Exception as e:
            return [{"type": "text", "text": f"Error inserting notes: {e}"}]

    if name == "run_code":
        try:
            code = tool_input.get("code", "")
            result = await mgr.run_code(code)
            return [{"type": "text", "text": result}]
        except Exception as e:
            return [{"type": "text", "text": f"Error running code: {e}"}]

    return [{"type": "text", "text": f"Unknown tool: {name}"}]


def capture_context() -> dict:
    """Capture document context + page text + screenshot on the MAIN THREAD.

    Must be called from the main thread (uses AppKit/Quartz).
    Returns dict with 'doc_info' (str), 'page_text' (str or None),
    and 'image_b64' (str or None).
    """
    ctx = get_document_context()

    # Build doc info string
    parts = [f"App: {ctx['app_name']}"]
    if ctx["filename"]:
        parts.append(f"File: {ctx['filename']}")
    if ctx["file_path"]:
        parts.append(f"Path: {ctx['file_path']}")
    if ctx["current_page"] is not None:
        page_str = f"Page: {ctx['current_page']}"
        if ctx["total_pages"]:
            page_str += f" / {ctx['total_pages']}"
        parts.append(page_str)
    if not ctx["filename"] and not ctx["current_page"]:
        parts.append(f"Window title: {ctx['title']}")

    print(f"[DEBUG] Document context: {parts}", flush=True)

    # Capture screenshot (compress to JPEG, max ~300KB)
    image_b64 = None
    window_id = ctx.get("window_id")
    if window_id is not None:
        try:
            from PIL import Image
            png_path = os.path.join(tempfile.gettempdir(), "marginalia_capture.png")
            jpg_path = os.path.join(tempfile.gettempdir(), "marginalia_capture.jpg")
            capture_window(window_id, png_path)

            # Resize and compress
            img = Image.open(png_path)
            # Limit to 1200px wide
            if img.width > 1200:
                ratio = 1200 / img.width
                img = img.resize((1200, int(img.height * ratio)), Image.LANCZOS)
            img.convert("RGB").save(jpg_path, "JPEG", quality=60)

            with open(jpg_path, "rb") as f:
                image_b64 = base64.standard_b64encode(f.read()).decode("utf-8")
            print(f"[DEBUG] Screenshot captured, compressed to {os.path.getsize(jpg_path)} bytes", flush=True)
        except Exception as e:
            print(f"[DEBUG] Screenshot failed: {e}", flush=True)
    else:
        print("[DEBUG] No document window found to capture", flush=True)

    return {
        "doc_info": "\n".join(parts),
        "page_text": ctx.get("page_text"),
        "image_b64": image_b64,
    }


def _get_client() -> anthropic.AsyncAnthropic:
    """Create an async Anthropic client configured for DashScope."""
    api_key = _config.get("ANTHROPIC_API_KEY", "")
    base_url = _config.get("ANTHROPIC_BASE_URL", "")

    return anthropic.AsyncAnthropic(
        api_key="sk-placeholder",  # required but overridden by header
        base_url=base_url if base_url else None,
        default_headers={"Authorization": f"Bearer {api_key}"},
        timeout=httpx.Timeout(120.0, connect=30.0),
    )


def _build_user_content(prompt: str, screen_ctx: Optional[dict]) -> list:
    """Build user message with document context, page text, and optional screenshot."""
    content = []

    if screen_ctx:
        # Add document info
        info_text = f"[Current document info]\n{screen_ctx['doc_info']}"
        content.append({"type": "text", "text": info_text})

        # Add extracted page text (primary source — always works)
        if screen_ctx.get("page_text"):
            content.append({
                "type": "text",
                "text": f"[Page content (extracted text)]\n{screen_ctx['page_text']}",
            })

        # Add screenshot if available (supplementary — for diagrams/charts)
        if screen_ctx.get("image_b64"):
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": screen_ctx["image_b64"],
                },
            })

    content.append({"type": "text", "text": prompt})
    return content


async def run_query(
    prompt: str,
    history: Optional[list] = None,
    screen_ctx: Optional[dict] = None,
) -> AsyncGenerator:
    """Run an agent query with tool use loop.

    Args:
        prompt: User's question
        history: Conversation history
        screen_ctx: Pre-captured screen context from main thread (from capture_context())

    Yields (type, data) tuples:
      "status" - status update (capturing/thinking/running code/etc.)
      "text"   - text response
      "done"   - query complete
      "error"  - error message
    """
    client = _get_client()
    model = _config.get("MODEL", "qwen3.5-plus")

    messages = list(history) if history else []

    # Build user message with screen context
    yield ("status", "📄 Reading current page...")
    user_content = _build_user_content(prompt, screen_ctx)
    messages.append({"role": "user", "content": user_content})

    max_iterations = 10

    try:
        for iteration in range(max_iterations):
            yield ("status", "🧠 Thinking...")
            print(f"[DEBUG] Sending request to {model}...", flush=True)
            response = await client.messages.create(
                model=model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
            )
            print(f"[DEBUG] Got response, stop_reason={response.stop_reason}", flush=True)

            # Collect text from the response
            text_parts = []
            tool_use_blocks = []
            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                elif block.type == "tool_use":
                    tool_use_blocks.append(block)

            # Yield any text
            if text_parts:
                yield ("text", "\n".join(text_parts))

            # If no tool calls, we're done
            if response.stop_reason != "tool_use":
                break

            # Execute tools and continue the loop
            messages.append({"role": "assistant", "content": response.content})

            tool_results = []
            for tool_block in tool_use_blocks:
                print(f"[DEBUG] Executing tool: {tool_block.name}", flush=True)
                yield ("status", f"⚙️ Running: {tool_block.name}...")
                result_content = await _execute_tool(tool_block.name, tool_block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_block.id,
                    "content": result_content,
                })

            messages.append({"role": "user", "content": tool_results})

        yield ("done", None)

    except Exception as e:
        print(f"[DEBUG] Error: {e}", flush=True)
        yield ("error", str(e))
    finally:
        try:
            await client.close()
        except Exception:
            pass

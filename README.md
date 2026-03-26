# Marginalia

A macOS desktop learning agent that sees your PDF/PPT slides, answers questions about them, and writes study notes back into the original file.

## What It Does

1. **Detects the active document** -- automatically finds the frontmost PDF/PPT viewer (Preview, PowerPoint, Keynote, etc.) and captures the current page via macOS Quartz APIs.
2. **Understands page content** -- sends the screenshot + extracted text to an LLM, so you can ask questions about formulas, diagrams, or concepts on the current slide.
3. **Inserts notes back** -- generates beautifully formatted study notes (with LaTeX math rendering) and inserts them as new pages directly into the PDF or PPTX file.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Electrobun (Bun + native macOS window)                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Main Process (src/bun/index.ts)                   │  │
│  │  Creates window, tray, menu                        │  │
│  │  Auto-starts Python backend                        │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Webview (src/mainview/)                           │  │
│  │  Chat UI with mascot animation                     │  │
│  │  fetch → http://127.0.0.1:8765/api/chat (SSE)     │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│  Python Backend (core/server.py) — FastAPI on :8765      │
│  POST /api/chat → capture_context() + run_query() → SSE │
│  Sandbox init via OpenSandbox (Docker)                   │
└──────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────┐     ┌─────────────────────────────────┐
│  core/screen.py  │     │  core/agent.py                  │
│  macOS Quartz    │     │  LLM tool loop                  │
│  screencapture   │     │  Tools: insert_notes, run_code  │
│  lsof, mdfind    │     │  run_code → OpenSandbox         │
│  PDF/PPTX text   │     │  insert_notes → local + path    │
│  extraction      │     │  validation                     │
└──────────────────┘     └─────────────────────────────────┘
```

## Security: OpenSandbox Integration

LLM-generated code (`run_code` tool) is executed inside isolated Docker containers via [OpenSandbox](https://github.com/alibaba/OpenSandbox), preventing:

- **Filesystem access** -- container cannot see host files (`~/.ssh`, `.env`, etc.)
- **Data exfiltration** -- egress network policy blocks all outbound traffic except `pypi.org`
- **System commands** -- container runs with dropped capabilities and no privilege escalation

When Docker is unavailable, falls back to a restricted local executor with import guards, or to OpenSandbox cloud (`api.opensandbox.io`).

See `core/sandbox.py` for implementation details.

## Prerequisites

- **macOS** (uses Quartz APIs for screen capture)
- **Python 3.10-3.12** + [uv](https://docs.astral.sh/uv/)
- **Bun** + npm (for Electrobun frontend)
- **Docker Desktop** (optional, for OpenSandbox isolation)

## Setup

1. Clone and install dependencies:

```bash
git clone https://github.com/zzy1130/Marginalia.git
cd Marginalia
uv sync
bun install
```

2. Create `.env` with your API credentials:

```bash
cp .env.example .env
# Edit .env with your API key
```

Required variables:

```
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://coding.dashscope.aliyuncs.com/apps/anthropic
MODEL=qwen3.5-plus

SANDBOX_MODE=auto
OPENSANDBOX_API_KEY=
OPENSANDBOX_DOMAIN=api.opensandbox.io
```

3. Run:

```bash
./start.sh
```

This will:
- Sync Python dependencies
- Check for Docker and pre-pull sandbox images (if available)
- Start the FastAPI backend on port 8765
- Build and launch the Electrobun frontend

## Usage

1. Open a PDF or PPTX file in Preview, PowerPoint, Keynote, or another supported viewer.
2. Launch Marginalia (it appears as a floating window).
3. Ask a question about the current page -- Marginalia captures the screen and extracts text automatically.
4. Request notes -- the LLM generates formatted study notes with LaTeX math and inserts them directly into your file.

## Project Structure

```
core/
  server.py       FastAPI backend with SSE streaming
  agent.py        LLM agent with tool-use loop
  screen.py       macOS screen capture and document detection
  sandbox.py      OpenSandbox integration for secure code execution
  get_context.py  Standalone context capture helper
src/
  bun/            Electrobun main process (window, tray, menu)
  mainview/       Chat UI webview (HTML + TypeScript)
  shared/         Shared type definitions
scripts/
  start.sh        Development launcher
  package.sh      DMG packaging script
  postBuild.ts    Electrobun post-build hook (bundles Python)
```

## Tech Stack

- **Frontend**: [Electrobun](https://electrobun.dev/) (Bun + native macOS window), TypeScript, [marked](https://marked.js.org/), [KaTeX](https://katex.org/)
- **Backend**: Python 3.12, FastAPI, uvicorn
- **AI**: Anthropic-compatible API (qwen3.5-plus via DashScope)
- **Screen**: macOS Quartz (pyobjc), `screencapture`, `lsof`, `mdfind`, `osascript`
- **Documents**: PyMuPDF, python-pptx, matplotlib (LaTeX rendering), Pillow
- **Security**: [OpenSandbox](https://github.com/alibaba/OpenSandbox) (Docker-based code isolation)

## License

MIT

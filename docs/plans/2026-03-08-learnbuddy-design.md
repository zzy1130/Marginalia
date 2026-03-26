# Marginalia - Design Document

## Problem
Self-studying from PDF/PPT slides requires 3 tedious steps: screenshot → ask AI → save notes.
Need a unified desktop agent that sees the current page, answers questions, and writes notes back.

## Solution
A macOS floating desktop app powered by Claude Agent SDK that:
1. Detects the frontmost PDF/PPT viewer and captures the current page
2. Lets user ask questions via chat, AI understands the page content
3. Writes notes back into the original file (new pages/slides)

## Architecture

```
┌─── Marginalia Window (PyQt6) ───┐
│ Status: slides.pdf  p.12/35     │
│ ┌─────────────────────────────┐ │
│ │ Chat history (scrollable)   │ │
│ ├─────────────────────────────┤ │
│ │ [Input]            [Send]   │ │
│ │ [Explain Page] [Take Notes] │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘

GUI ──→ Agent SDK (qwen3.5-plus via DashScope)
          ├── Built-in: Read, Write, Bash
          └── Custom MCP: capture_screen, get_active_document
```

## Tech Stack
- **GUI**: PyQt6 (floating window + system tray + global hotkey)
- **AI**: Claude Agent SDK → qwen3.5-plus via DashScope Anthropic-compatible API
- **Screen**: macOS Quartz/AppKit APIs (pyobjc) + screencapture
- **File ops**: Agent uses Bash + PDF/PPTX skills (reportlab, python-pptx, PyMuPDF)
- **Hotkey**: pynput for global Cmd+Shift+L

## Key Decisions
- Agent SDK with `env` param to set ANTHROPIC_BASE_URL for DashScope
- Custom MCP tools for screen capture and document detection
- Agent has Bash access to run Python scripts for PDF/PPT manipulation
- PDF/PPTX skill knowledge embedded in system prompt
- GUI auto-captures screen on each message; agent can also capture manually
- Session resumption for multi-turn conversation context

## Model Config
- Model: qwen3.5-plus
- Base URL: https://coding.dashscope.aliyuncs.com/apps/anthropic
- API Key: stored in .env

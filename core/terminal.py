"""Terminal monitoring and interaction for macOS.

Scans Cursor IDE terminals, iTerm2, and Terminal.app for AI agent sessions
that need human input. Also provides typing into specific terminals.

Usage:
    python terminal.py scan                          # JSON array of alerts
    python terminal.py type <terminal_id> <text>     # type text into terminal
"""

import sys
import os
import json
import subprocess
import re
from pathlib import Path

NEEDS_INPUT_PATTERNS = [
    r"Allow\?\s*\[Y/n\]",
    r"Do you want to proceed",
    r"Press Enter to continue",
    r"\[y/n\]\s*$",
    r"\[Y/n\]\s*$",
    r"\[yes/no\]\s*$",
    r"Continue\?\s*$",
    r"Proceed\?\s*$",
    r"Approve\?",
    r"Are you sure\?",
    r"Would you like to",
    r"Do you want to",
    r"Add .+ to the chat\?",
    r"Run .+ command\?",
    r"\?\s*\([^)]+\)\s*$",
    r"Enter your choice",
    r"Select an option",
    r"User input required",
    r"waiting for.+input",
    r"confirm\s*\?",
]

AI_INDICATORS = [
    "claude", "cursor", "aider", "copilot", "codex",
    "anthropic", "openai", "agent", "cline", "windsurf",
    "pi", "gemini", "gpt", "llm", "chatgpt", "deepseek",
    "qwen", "dashscope", "bailian",
]


def _is_ai_terminal(content: str, command: str = "") -> bool:
    check = command.lower()
    return any(ind in check for ind in AI_INDICATORS)


def _needs_input(content: str) -> tuple:
    lines = content.strip().split("\n")
    tail = "\n".join(lines[-15:])

    for pattern in NEEDS_INPUT_PATTERNS:
        m = re.search(pattern, tail, re.IGNORECASE | re.MULTILINE)
        if m:
            for line in reversed(lines[-15:]):
                if re.search(pattern, line, re.IGNORECASE):
                    return True, line.strip()
            return True, m.group(0)
    return False, ""


def _escape_for_applescript(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


# ── Cursor terminals ──────────────────────────────────────────────

def scan_cursor_terminals() -> list:
    cursor_base = Path.home() / ".cursor" / "projects"
    if not cursor_base.exists():
        return []

    results = []
    for term_file in cursor_base.glob("*/terminals/*.txt"):
        try:
            content = term_file.read_text(errors="replace")
        except Exception:
            continue

        parts = content.split("---", 2)
        if len(parts) < 3:
            continue

        meta = {}
        for line in parts[1].strip().split("\n"):
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip()] = val.strip()

        body = parts[2]

        results.append({
            "source": "cursor",
            "id": f"cursor:{term_file.parent.parent.name}:{term_file.stem}",
            "project": term_file.parent.parent.name,
            "terminal_num": term_file.stem,
            "pid": meta.get("pid", ""),
            "cwd": meta.get("cwd", ""),
            "command": meta.get("active_command", meta.get("last_command", "")),
            "active": "active_command" in parts[1],
            "content": body.strip()[-4000:],
        })
    return results


# ── iTerm2 ────────────────────────────────────────────────────────

def scan_iterm2() -> list:
    try:
        subprocess.run(["pgrep", "-x", "iTerm2"], capture_output=True, timeout=2, check=True)
    except Exception:
        return []

    script = '''
tell application "iTerm2"
    set output to ""
    repeat with w in windows
        set wId to id of w
        set tIdx to 0
        repeat with t in tabs of w
            set tIdx to tIdx + 1
            repeat with s in sessions of t
                set sId to unique ID of s
                set sName to name of s
                set sText to text of s
                set output to output & "<<SESSION>>" & linefeed
                set output to output & "id:" & sId & linefeed
                set output to output & "window:" & wId & linefeed
                set output to output & "tab:" & tIdx & linefeed
                set output to output & "name:" & sName & linefeed
                set output to output & "<<BODY>>" & linefeed
                set output to output & sText & linefeed
                set output to output & "<<END>>" & linefeed
            end repeat
        end repeat
    end repeat
    return output
end tell
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script], capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return []
    except Exception:
        return []

    sessions = []
    for block in result.stdout.split("<<SESSION>>\n")[1:]:
        meta = {}
        body_start = block.find("<<BODY>>\n")
        body_end = block.find("\n<<END>>")

        header = block[:body_start] if body_start >= 0 else block
        body = block[body_start + len("<<BODY>>\n"):body_end] if body_start >= 0 and body_end >= 0 else ""

        for line in header.strip().split("\n"):
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip()] = val.strip()

        sessions.append({
            "source": "iterm2",
            "id": f"iterm2:{meta.get('id', '')}",
            "window": meta.get("window", ""),
            "tab": meta.get("tab", ""),
            "name": meta.get("name", ""),
            "active": True,
            "content": body[-4000:],
            "session_id": meta.get("id", ""),
        })
    return sessions


# ── Terminal.app ──────────────────────────────────────────────────

def scan_terminal_app() -> list:
    try:
        subprocess.run(["pgrep", "-x", "Terminal"], capture_output=True, timeout=2, check=True)
    except Exception:
        return []

    script = '''
tell application "Terminal"
    set output to ""
    repeat with w in windows
        set wId to id of w
        set wName to name of w
        set tIdx to 0
        repeat with t in tabs of w
            set tIdx to tIdx + 1
            set tContent to history of t
            set tBusy to busy of t
            set output to output & "<<TAB>>" & linefeed
            set output to output & "window:" & wId & linefeed
            set output to output & "tab:" & tIdx & linefeed
            set output to output & "name:" & wName & linefeed
            set output to output & "busy:" & tBusy & linefeed
            set output to output & "<<BODY>>" & linefeed
            set output to output & tContent & linefeed
            set output to output & "<<END>>" & linefeed
        end repeat
    end repeat
    return output
end tell
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script], capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return []
    except Exception:
        return []

    tabs = []
    for block in result.stdout.split("<<TAB>>\n")[1:]:
        meta = {}
        body_start = block.find("<<BODY>>\n")
        body_end = block.find("\n<<END>>")
        header = block[:body_start] if body_start >= 0 else block
        body = block[body_start + len("<<BODY>>\n"):body_end] if body_start >= 0 and body_end >= 0 else ""

        for line in header.strip().split("\n"):
            if ":" in line:
                key, _, val = line.partition(":")
                meta[key.strip()] = val.strip()

        tabs.append({
            "source": "terminal_app",
            "id": f"terminal:{meta.get('window', '')}:{meta.get('tab', '')}",
            "window_id": meta.get("window", ""),
            "tab_num": meta.get("tab", ""),
            "name": meta.get("name", ""),
            "active": meta.get("busy", "false").lower() == "true",
            "content": body[-4000:],
        })
    return tabs


# ── Scan all ──────────────────────────────────────────────────────

def scan_all() -> list:
    """Legacy: returns only needs_input alerts."""
    statuses = get_all_status()
    return [t for t in statuses if t.get("needs_input")]


def get_all_status() -> list:
    """Return ALL terminals with enriched status fields.

    Each terminal dict gets extra keys:
      needs_input (bool), prompt (str), tail (str, last 15 meaningful lines)
    """
    all_terminals = []
    all_terminals.extend(scan_cursor_terminals())
    all_terminals.extend(scan_iterm2())
    all_terminals.extend(scan_terminal_app())

    for term in all_terminals:
        content = term.get("content", "")
        command = term.get("command", "")

        is_ai = _is_ai_terminal(content, command)
        is_cursor_active = term.get("source") == "cursor" and term.get("active")

        waiting, prompt_line = _needs_input(content)
        term["needs_input"] = bool(waiting and (is_ai or is_cursor_active))
        term["is_ai"] = is_ai
        term["prompt"] = prompt_line if waiting else ""

        lines = [l for l in content.strip().split("\n") if l.strip()]
        term["tail"] = "\n".join(lines[-60:])

        term["name"] = term.get("name", term.get("project", ""))

    return all_terminals


# ── Type into terminal ────────────────────────────────────────────

def type_in_terminal(terminal_id: str, text: str) -> str:
    parts = terminal_id.split(":", 2)
    source = parts[0]
    safe_text = _escape_for_applescript(text)

    if source == "iterm2" and len(parts) >= 2:
        session_id = parts[1]
        script = f'''
tell application "iTerm2"
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                if unique ID of s is "{session_id}" then
                    tell s to write text "{safe_text}"
                    return "ok"
                end if
            end repeat
        end repeat
    end repeat
    return "session_not_found"
end tell
'''
        try:
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
            return r.stdout.strip() or "ok"
        except Exception as e:
            return f"error: {e}"

    elif source == "terminal" and len(parts) >= 3:
        window_id, tab_num = parts[1], parts[2]
        script = f'''
tell application "Terminal"
    set targetWindow to window id {window_id}
    set selected tab of targetWindow to tab {tab_num} of targetWindow
    activate
end tell
delay 0.3
tell application "System Events"
    tell process "Terminal"
        keystroke "{safe_text}"
        keystroke return
    end tell
end tell
'''
        try:
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
            return "ok"
        except Exception as e:
            return f"error: {e}"

    elif source == "cursor":
        proc = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
        proc.communicate(text.encode())
        script = '''
tell application "Cursor"
    activate
end tell
delay 0.3
tell application "System Events"
    tell process "Cursor"
        key code 50 using control down
        delay 0.3
        keystroke "v" using command down
        delay 0.1
        keystroke return
    end tell
end tell
'''
        try:
            subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
            return f"clipboard_ready: text copied to clipboard and paste attempted. If nothing appeared, grant Accessibility permission to Marginalia in System Settings, or manually Cmd+V in the terminal."
        except Exception as e:
            return f"clipboard_only: {e} — text is on clipboard, paste with Cmd+V"

    return f"unknown_source:{source}"


# ── CLI entry ─────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: terminal.py scan|type"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        print(json.dumps(scan_all()))
    elif cmd == "status":
        print(json.dumps(get_all_status()))
    elif cmd == "type":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "usage: terminal.py type <id> <text>"}))
            sys.exit(1)
        result = type_in_terminal(sys.argv[2], sys.argv[3])
        print(json.dumps({"result": result}))
    else:
        print(json.dumps({"error": f"unknown command: {cmd}"}))
        sys.exit(1)

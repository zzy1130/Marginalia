"""Observe the current desktop focus and emit structured JSON."""

import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.screen import get_frontmost_window_info


_TERMINAL_APPS = {"Terminal", "iTerm2", "Warp", "Cursor"}
_CODING_APPS = {"Cursor", "Visual Studio Code", "Xcode", "PyCharm", "WebStorm"}
_WRITING_APPS = {"Notes", "Obsidian", "Typora", "Notion", "Bear"}
_PRESENTING_APPS = {"Keynote", "Microsoft PowerPoint"}
_READING_APPS = {
    "Preview",
    "Skim",
    "PDF Expert",
    "Adobe Acrobat",
    "Adobe Acrobat Reader",
    "Safari",
    "Google Chrome",
    "Arc",
}


def _empty_observation(status: str, reason: str | None = None) -> dict:
    return {
        "status": status,
        "reason": reason,
        "active_window": {"app_name": "", "title": ""},
        "activity": {"category": "idle", "app": "", "title": "", "sub": None},
        "window_count": 0,
        "switch_count_1min": 0,
        "stay_duration_seconds": 0,
        "time_context": _time_context(),
        "recent_activity_summary": {},
        "recent_categories": [],
    }


def _time_context() -> str:
    hour = datetime.now().hour
    if hour < 6:
        return "late_night"
    if hour < 12:
        return "morning"
    if hour < 18:
        return "afternoon"
    return "evening"


def _categorize(app_name: str, title: str) -> tuple[str, str | None]:
    lower_title = title.lower()

    if app_name in _TERMINAL_APPS:
        if "cursor" in app_name.lower():
            return "coding", "editor"
        return "terminal", "shell"

    if app_name in _CODING_APPS:
        return "coding", "editor"

    if app_name in _PRESENTING_APPS or any(ext in lower_title for ext in (".ppt", ".pptx", ".key")):
        return "presenting", "slides"

    if app_name in _READING_APPS or ".pdf" in lower_title:
        return "reading", "document"

    if app_name in _WRITING_APPS:
        return "writing", "notes"

    if app_name in {"Slack", "Discord", "Messages", "WeChat"}:
        return "communication", "chat"

    if app_name in {"Finder"}:
        return "organizing", "files"

    return "desktop", None


def main():
    window = get_frontmost_window_info()
    status = window.get("status", "ok")
    reason = window.get("reason")
    if status != "ok":
        print(json.dumps(_empty_observation(status, reason)))
        return

    app_name = window.get("app_name", "")
    title = window.get("title", "")
    category, sub = _categorize(app_name, title)

    result = {
        "status": "ok",
        "reason": None,
        "active_window": {
            "app_name": app_name,
            "title": title,
        },
        "activity": {
            "category": category,
            "app": app_name,
            "title": title,
            "sub": sub,
        },
        "window_count": 1,
        "switch_count_1min": 0,
        "stay_duration_seconds": 0,
        "time_context": _time_context(),
        "recent_activity_summary": {category: 1},
        "recent_categories": [category],
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

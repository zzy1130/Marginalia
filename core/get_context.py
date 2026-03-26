"""Standalone helper: capture document context + screenshot, output JSON."""

import base64
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.screen import get_document_context, capture_window


def main():
    include_image = "--no-image" not in sys.argv[1:]
    ctx = get_document_context()

    status = ctx.get("status", "ok")
    reason = ctx.get("reason")
    parts = [f"Status: {status}"]

    if status == "unavailable":
        parts.append("Desktop observation unavailable")
        if reason:
            parts.append(f"Reason: {reason}")
        parts.append("Hint: check macOS Screen Recording / Accessibility permissions if this keeps happening")
    elif status == "no_document":
        parts.append("No supported PDF/PPT window detected")
    else:
        parts.append(f"App: {ctx['app_name']}")
        if ctx["filename"]:
            parts.append(f"File: {ctx['filename']}")
        if ctx["file_path"]:
            parts.append(f"Path: {ctx['file_path']}")
        elif ctx["filename"]:
            parts.append("Path: unavailable")
        if ctx["current_page"] is not None:
            page_str = f"Page: {ctx['current_page']}"
            if ctx["total_pages"]:
                page_str += f" / {ctx['total_pages']}"
            parts.append(page_str)
        else:
            parts.append("Page: unavailable")
        if ctx["title"]:
            parts.append(f"Window title: {ctx['title']}")

    image_b64 = None
    window_id = ctx.get("window_id")
    if include_image and status == "ok" and window_id is not None:
        try:
            from PIL import Image

            png_path = os.path.join(tempfile.gettempdir(), "marginalia_capture.png")
            jpg_path = os.path.join(tempfile.gettempdir(), "marginalia_capture.jpg")
            capture_window(window_id, png_path)
            img = Image.open(png_path)
            if img.width > 1200:
                ratio = 1200 / img.width
                img = img.resize((1200, int(img.height * ratio)), Image.LANCZOS)
            img.convert("RGB").save(jpg_path, "JPEG", quality=60)
            with open(jpg_path, "rb") as f:
                image_b64 = base64.standard_b64encode(f.read()).decode("utf-8")
        except Exception:
            pass

    result = {
        "status": status,
        "reason": reason,
        "doc_info": "\n".join(parts),
        "page_text": ctx.get("page_text"),
        "image_b64": image_b64,
        "app_name": ctx["app_name"],
        "filename": ctx.get("filename"),
        "file_path": ctx.get("file_path"),
        "current_page": ctx.get("current_page"),
        "total_pages": ctx.get("total_pages"),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

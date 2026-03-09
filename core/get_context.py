"""Standalone helper: capture document context + screenshot, output JSON."""

import base64
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.screen import get_document_context, capture_window


def main():
    ctx = get_document_context()

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

    image_b64 = None
    window_id = ctx.get("window_id")
    if window_id is not None:
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
        "doc_info": "\n".join(parts),
        "page_text": ctx.get("page_text"),
        "image_b64": image_b64,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()

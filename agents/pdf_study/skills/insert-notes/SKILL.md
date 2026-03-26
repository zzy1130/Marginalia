---
name: insert-notes
description: Insert beautifully formatted study notes into PDF/PPTX files
trigger: User asks to take notes, add notes, or insert notes into their document
---

## When to use

When the user asks you to take notes, insert notes, or add annotations to their PDF or PPT file.

## How it works

Call the helper script `insert_notes.py` via `run_code`. Fill in three variables:

- `markdown_content` — your notes in Markdown format (supports headings, bold, lists, tables, blockquotes, LaTeX math with `$...$` and `$$...$$`)
- `file_path` — absolute path from the document context
- `page_number` — 1-based page number (same as what the user sees). Notes are inserted AFTER this page.

## Code to execute

```python
import sys, os
sys.path.insert(0, os.path.join(os.environ["MARGINALIA_ROOT"], "agents", "pdf_study", "skills", "insert-notes"))
from insert_notes import insert_notes

result = insert_notes(
    markdown_content=r"""
<YOUR NOTES IN MARKDOWN HERE>
""",
    file_path="<ABSOLUTE PATH FROM DOCUMENT CONTEXT>",
    page_number=<PAGE NUMBER THE USER IS ON>,
)
print(result)
```

## Rules

- `page_number` is 1-based — pass the page number exactly as the user says it. No conversion needed.
- The script handles CSS styling, LaTeX rendering, CJK fonts, and PDF insertion automatically.
- Do NOT generate HTML/PDF code manually. Always call `insert_notes()`.
- ONE A4 page max for notes (~250 words).

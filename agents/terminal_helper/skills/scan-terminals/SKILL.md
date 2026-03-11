---
name: scan-terminals
description: Scan all open terminals for AI agents that need human input
trigger: User asks to check terminals, or system pushes a terminal alert
---

## When to use

When you need to check which terminals have AI agents (Claude Code, aider, Copilot, etc.) waiting for human input. This is also called automatically by the background monitor.

## Code to execute

```python
from core.terminal import scan_all
import json

alerts = scan_all()
if alerts:
    for a in alerts:
        print(f"[{a['source']}] {a.get('name', 'unknown')}")
        print(f"  ID: {a['id']}")
        print(f"  Prompt: {a['prompt']}")
        print(f"  Context (last lines):")
        for line in a['context'].split('\n')[-10:]:
            print(f"    {line}")
        print()
else:
    print("No terminals currently need input.")
```

## What you get back

Each alert has:
- `id` — terminal identifier (pass this to `type-in-terminal`)
- `source` — `cursor`, `iterm2`, or `terminal_app`
- `name` — window/project name
- `prompt` — the line that triggered the alert
- `context` — last 25 lines of terminal output

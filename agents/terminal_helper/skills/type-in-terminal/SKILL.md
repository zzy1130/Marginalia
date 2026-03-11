---
name: type-in-terminal
description: Type a response into a specific terminal
trigger: User tells you what to type/respond to an AI agent terminal
---

## When to use

When the user tells you to respond to an AI agent's prompt in a specific terminal. Always use the terminal ID from `scan-terminals`.

## Code to execute

Replace `TERMINAL_ID` and `RESPONSE_TEXT` with the actual values:

```python
from core.terminal import type_in_terminal

TERMINAL_ID = "<terminal id from scan-terminals>"
RESPONSE_TEXT = "<what the user wants to type>"

result = type_in_terminal(TERMINAL_ID, RESPONSE_TEXT)
print(f"Typed into terminal: {result}")
```

## Rules

- **NEVER** type anything without the user's explicit instruction.
- Always confirm which terminal you are responding to.
- For simple approvals (user says "yes", "y", "approve"), type that directly.
- For iTerm2 terminals: `write text` is used — text goes directly to the session.
- For Terminal.app: the window is activated and keystrokes are sent.
- For Cursor terminals: text is pasted via clipboard.

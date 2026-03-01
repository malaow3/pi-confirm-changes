# pi-confirm-changes

A [pi](https://github.com/mariozechner/pi) extension that intercepts file-modifying tool calls (write, edit) and bash commands, prompting the user for approval before execution.

## Features

- **Write/Edit control** — configurable per-operation permission: `"allow"`, `"deny"`, or `"ask"` (default)
- **Bash command control** — configurable allow/deny lists via `operations.json`
- **Compound command parsing** — `cd /tmp && rm -rf *` is split and each part checked independently
- **Three response options:**
  - **Approve** — operation proceeds
  - **Reject** (or Escape) — operation blocked, agent stops and asks the user what to do
  - **Skip** — operation blocked silently, agent continues

## Install

```bash
pi install git:github.com/en-ver/pi-confirm-changes
```

## Update

```bash
pi update
```

This pulls the latest changes from the repository. Packages without a pinned version (like git sources) are updated automatically.

## Remove

```bash
pi remove git:github.com/en-ver/pi-confirm-changes
```

## Context window impact

This extension uses only event handlers (`pi.on("tool_call", ...)`), not `pi.registerTool()`. It adds nothing to the system prompt and consumes zero tokens in the agent's context window. It is safe to include in your globally loaded packages without any overhead.

## Headless mode

In non-interactive mode (CI, scripts, `--mode json`), operations that would normally prompt for approval are blocked since there is no UI. However, `"allow"` and `"deny"` rules still apply — allowed bash commands and explicitly allowed write/edit operations pass through without prompting. Only operations requiring user confirmation are blocked.

## Configuration

Copy `operations.json` to `~/.pi/agent/operations.json` to configure rules. If the file is missing, all operations default to `"ask"`.

Rules are loaded once on startup. Use `/reload` to pick up changes.

### operations.json

```json
{
  "write": "ask",
  "edit": "ask",
  "bash": {
    "allow": ["ls", "cat", "grep", "find", "git status", "git log", "git diff"],
    "deny": []
  }
}
```

### Write/Edit permissions

The `write` and `edit` fields accept one of three values:

| Value | Behavior |
|---|---|
| `"ask"` | Prompt for approval (default) |
| `"allow"` | Auto-approve all operations |
| `"deny"` | Block all operations |

### Pattern matching

Patterns are prefix-based with word boundaries:

| Pattern | Matches | Doesn't match |
|---|---|---|
| `"rm"` or `"rm *"` | `rm`, `rm -rf`, `rm file.txt` | `rmdir` |
| `"git push"` | `git push`, `git push origin main` | `git status` |
| `"git"` or `"git *"` | all git commands | |

### Decision logic

For compound commands (`&&`, `||`, `;`, `|`), each sub-command is checked:

- **ANY** sub-command in deny → whole command denied
- **ANY** sub-command not in allow → prompt for approval
- **ALL** sub-commands in allow → auto-approve

## License

MIT

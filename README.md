# pi-confirm-changes

A [pi](https://github.com/mariozechner/pi) extension that intercepts file-modifying tool calls (write, edit) and bash commands, prompting the user for approval before execution.

## Features

- **Write/Edit approval** — every file write or edit prompts for confirmation
- **Bash command control** — configurable allow/deny lists via `operations.json`
- **Compound command parsing** — `cd /tmp && rm -rf *` is split and each part checked independently
- **Three response options:**
  - **Approve** — operation proceeds
  - **Reject** (or Escape) — operation blocked, agent stops and asks the user what to do
  - **Skip** — operation blocked silently, agent continues

## Install

```bash
pi install github:YOUR_USERNAME/pi-confirm-changes
```

## Configuration

After installing, copy `operations.json` to `~/.pi/agent/operations.json` to configure bash command rules.

### operations.json

```json
{
  "bash": {
    "allow": ["ls", "cat", "grep", "find", "git status", "git log", "git diff"],
    "deny": []
  }
}
```

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

# `.rulesync.local/` — personal agent rules (not shared)

Your private overlay on top of the team's shared agent instructions. The team SSOT
lives in [`.rulesync/`](../.rulesync/) and is committed; **this** directory is your
machine-local SSOT and is gitignored (only this `README.md` and `.gitignore` are
tracked, so the convention is visible without leaking anyone's content).

## How it works

```
.rulesync/rules/        (committed)  ──▶ shared agent instruction targets
.rulesync.local/rules.md (gitignored) ──▶ local agent instruction overlays
```

Write your personal rules in `rules.md` (plain Markdown, create it yourself), then:

```bash
bun run agents:local     # fan rules.md into the gitignored local slots
```

Your tools read both layers and merge them when they support project-local overlays.
The generated overlay files are gitignored, so nothing personal ever lands in the repo.

## Scope & limits

- **This repo only.** For preferences you want in *every* project, use your global
  agent config instead — e.g. `rulesync generate --global`.
- Covers tools with a native additive local slot. Agents that read a single shared
  instruction file with no project-local personal slot aren't layered here — put
  those preferences in your global config.
- Throwaway scratch notes go in [`.agent/`](../.agent/README.md), not here. This
  directory is for durable personal *rules*.

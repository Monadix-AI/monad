# `.rulesync.local/` — personal agent rules (not shared)

Your private overlay on top of the team's shared agent instructions. The team SSOT
lives in [`.rulesync/`](../.rulesync/) and is committed; **this** directory is your
machine-local SSOT and is gitignored (only this `README.md` and `.gitignore` are
tracked, so the convention is visible without leaking anyone's content).

## How it works

```
.rulesync/rules/        (committed)  ──▶ AGENTS.md, CLAUDE.md, .cursor/rules/overview.mdc, …
.rulesync.local/rules.md (gitignored) ──▶ CLAUDE.local.md, .cursor/rules/99-personal.local.mdc
```

Write your personal rules in `rules.md` (plain Markdown, create it yourself), then:

```bash
bun run agents:local     # fan rules.md into the gitignored local slots
```

Your tools read both layers and merge them: Claude Code reads `CLAUDE.md` **and**
`CLAUDE.local.md`; Cursor reads every `.mdc` under `.cursor/rules/`. The generated
overlay files are gitignored, so nothing personal ever lands in the repo.

## Scope & limits

- **This repo only.** For preferences you want in *every* project, use your global
  agent config instead (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, …) — e.g.
  `rulesync generate --global`.
- Covers the tools with a native additive local slot (Claude Code, Cursor). Agents
  that read a single `AGENTS.md` with no project-local personal slot (Codex, Gemini,
  …) aren't layered here — put those preferences in your global config.
- Throwaway scratch notes go in [`.agent/`](../.agent/README.md), not here. This
  directory is for durable personal *rules*.

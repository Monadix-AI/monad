# Documentation map

Every doc and instruction file in this repo belongs to exactly one audience. This
page is the index. The organizing rule — **who reads it**:

| Bucket | Audience | Committed? | Where it lives |
|---|---|---|---|
| 👤 **For humans** | People — process, governance, onboarding | yes | repo root + `.github/` |
| 🌐 **For any AI** | Tool-agnostic, canonical behaviour + knowledge | yes | `AGENTS.md` + `docs/` |
| 🤖 **For a specific AI** | Per-tool glue/config (Claude, Gemini, Cursor, …) | yes | `CLAUDE.md`, `GEMINI.md`, `.cursor/`, … |
| 🗒️ **Agent scratch** | Working memos a tool jots down mid-task | **no** (gitignored) | `.agent/` |

The single source of truth for agent *behaviour* is **`AGENTS.md`**. Everything in
the 🤖 bucket re-exports or points at it — never duplicate rules into a per-tool file.
Durable *knowledge* (how the code works and why) lives here in `docs/` and is linked
from `AGENTS.md`.

---

## 👤 For humans

Process, governance, onboarding. Read by people, not loaded into agent context.

| Doc | What it covers |
|---|---|
| [README.md](../README.md) | What monad is, quick start, pointers. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Local setup, required checks, commit & PR workflow. |
| [SECURITY.md](../SECURITY.md) | How to report a vulnerability; scope. |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community standards. |
| [CHANGELOG.md](../CHANGELOG.md) | Notable changes per release. |
| [LICENSE](../LICENSE) | License terms. |
| `.github/` | PR template, issue templates, CODEOWNERS, CI workflows. |

## 🌐 For any AI (canonical)

Tool-agnostic. `AGENTS.md` is the [open cross-tool standard](https://agents.md) for
agent behaviour; `docs/` is the shared knowledge base it links into. Both are also
useful to humans, but they are the source of truth that every AI tool draws from.

**Behaviour:** [AGENTS.md](../AGENTS.md) — Bun runtime, build/env, code style, design
principles, typing, testing, and the CodeGraph section. The canonical rules.

**Knowledge base** (`docs/`):

| Doc | What it covers |
|---|---|
| [design-principles.md](design-principles.md) | Cross-platform parity and agent containment. |
| [architecture.md](architecture.md) | Module boundaries, dependency directions, design decisions. |
| [conventions.md](conventions.md) | Code style (comments, file length, abstraction) + typing rules + audited exceptions. |
| [runtime.md](runtime.md) | How the daemon binds — transport (TCP/UDS), config, env, security model. |
| [session-origin.md](session-origin.md) | Session provenance: identity, write/branch access policy, env snapshot, client extension. |
| [security-guidelines.md](security-guidelines.md) | Code-level rules for security-sensitive changes; PR security checklist. |
| [performance-guidelines.md](performance-guidelines.md) | Performance budgets, profiling, hotspots. |
| [ui-guidelines.md](ui-guidelines.md) | Visual design system, component patterns, accessibility. |
| [ux-guidelines.md](ux-guidelines.md) | Interaction model, copy, loading/error/empty states. |
| [ux-writing-guidelines.md](ux-writing-guidelines.md) | Product voice, microcopy, sentence-style capitalization, accessibility text, and review checklist. |
| [model-providers.md](model-providers.md) | The model gateway: providers, routing, credentials. |
| [tools.md](tools.md) | The built-in tool set: registry layout, the uniform `register` module contract, assembly, and authoring/security rules. |
| [skills.md](skills.md) | The agent skills system (`SKILL.md` / agentskills.io standard). |
| [atoms.md](atoms.md) | The atom pack system. |
| [hooks.md](hooks.md) | Lifecycle hooks: events, the value contract, command + atom-pack hooks, dispatch semantics, sequence diagrams. |
| [acp.md](acp.md) | The ACP transport (monad as an editor agent). |
| [peer-federation.md](peer-federation.md) | Daemon-to-daemon task delegation (compute federation) + inbound approval. |
| [web-router.md](web-router.md) | The web router. |
| [channel-conformance.md](channel-conformance.md) | Channel (IM gateway) conformance. |
| [worktree.md](worktree.md) | Worktree development: feature workflow (init → test → rebase → audit → squash-merge) + environment reference. |
| [proposals/](proposals/) | Design proposals not yet (or never) implemented. |

## 🤖 For a specific AI (per-tool glue)

Each tool's entry point is **thin**: it re-exports `AGENTS.md` (so the canonical
rules load) plus any tool-specific machine config. Edit `AGENTS.md` for behaviour;
edit these only for tool wiring.

| File / dir | Tool | Role |
|---|---|---|
| [CLAUDE.md](../CLAUDE.md) | Claude Code | Re-exports `AGENTS.md` via `@AGENTS.md`. |
| [.claude/](../.claude) | Claude Code | `settings.json` + project-scoped pointer (no duplicated rules). |
| [GEMINI.md](../GEMINI.md) | Gemini CLI | Re-exports `AGENTS.md` via `@AGENTS.md`. |
| [.gemini/](../.gemini) | Gemini CLI | MCP server config. |
| [.cursor/](../.cursor) | Cursor | MCP server config. |
| [.kiro/](../.kiro) | Kiro | MCP server config. |
| [.vscode/mcp.json](../.vscode/mcp.json) | VS Code | MCP server config. |
| [opencode.jsonc](../opencode.jsonc) | opencode | MCP server config. |
| [.mcp.json](../.mcp.json) | (generic MCP) | Default MCP server config. |

> The CodeGraph instructions used to be copied into `GEMINI.md` and `.claude/CLAUDE.md`
> by an injector. They now live once, in `AGENTS.md`. If the injector re-adds a
> `<!-- CODEGRAPH_START -->` block to a per-tool file, repoint it at `AGENTS.md`.

## 🗒️ Agent scratch — NOT committed

Working memos that vibe-coding tools produce mid-task (plans, notes, intermediate
analysis) go in one place: [`.agent/`](../.agent). Everything inside is gitignored
except its `README.md`. Don't scatter stray `NOTES.md` / `TODO.md` files across the
tree — see [`.agent/README.md`](../.agent/README.md).

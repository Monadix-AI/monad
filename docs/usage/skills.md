# Skills

Skills are portable, filesystem-based capability packets that extend the Monad agent with
domain knowledge and procedures — **without paying the token cost until they're needed**.
Monad implements the [agentskills.io](https://agentskills.io) open standard, the same
`SKILL.md` format used across the agent ecosystem, so a
skill written once works across all of them.

## Where skills live

A skill is a **directory** under `~/.monad/skills/` containing a `SKILL.md`:

```
~/.monad/skills/
└── summarize-changes/
    ├── SKILL.md          # required: frontmatter + instructions
    ├── references/       # optional: docs loaded on demand (L3)
    └── scripts/          # optional: helper scripts
```

The frontmatter `name` **must equal the directory name**.

Skills are discovered from two scopes, in precedence order:

1. **Personal** — `~/.monad/skills/` (applies everywhere)
2. **Workspace** — `~/.monad/workspace/skills/` (travels with the workspace)

A workspace skill **shadows** a personal one of the same name. Both are watched for hot reload.

Skills can also be distributed as part of an atom pack — an installed pack contributes its
bundled skills alongside these scopes. See [atoms](../internals/atoms.md).

## SKILL.md format

```markdown
---
name: summarize-changes
description: Summarize uncommitted changes and flag risks. Use when the user asks what changed or wants a commit message.
---

Summarize the changes in two or three bullets, then list risks (missing error handling,
hardcoded values, tests to update). If there are none, say so.
```

### Frontmatter fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | ≤64 chars, lowercase alphanumeric + single hyphens, no `anthropic`/`claude`, equals dir name |
| `description` | yes | 1–1024 chars; say **what** it does and **when** to use it (this is all the model sees until the skill loads) |
| `license` | no | license name or bundled file |
| `compatibility` | no | environment requirement (≤500 chars). **Advisory, never blocks** — a semver range (e.g. `>=0.5.0`) is checked against the running Monad and warned if unmet; the skill still loads (override) — see below |
| `metadata` | no | arbitrary string→string map |
| `allowed-tools` | no | space/comma-separated tool patterns auto-approved while this skill is active — see below |
| `disable-model-invocation` | no | `true` → the model can't auto-load it; only `/name` invokes it |
| `user-invocable` | no | `false` → hidden from the `/` menu; the model may still load it |
| `requires` | no | eligibility gates — see below |
| `paths` | no | activation globs (relative to the workspace); the skill only auto-loads into context when a workspace file matches — see below |
| `context` | no | `fork` → run as an isolated subagent — see below |
| `tier` | no | `fast`/`smart`/`power` — capability tier the forked subagent runs at (only with `context: fork`); the routing layer picks a concrete model — see below |

### Eligibility gates (`requires`)

A skill can declare host prerequisites; when they aren't met it's **hidden from the agent**
entirely (not listed, not loadable, not `/name`-invocable) but still shown by `monad skill`
with the unmet reasons, so you know why:

```yaml
requires:
  bins: [git, jq]        # all must be on PATH
  anyBins: [rg, grep]    # at least one on PATH
  env: [DEPLOY_TOKEN]    # all must be set (non-empty)
  os: [linux, darwin]    # process.platform must match one
```

Re-evaluated on every hot reload, so installing a missing binary makes the skill light up.

### Activation globs (`paths`)

`requires` gates on the *host*; `paths` gates on *workspace content*. A skill that declares
activation globs only auto-loads into the model's context when the agent's workspace currently
contains a matching file — so a niche skill stays out of the way until it's relevant:

```yaml
paths:
  - "**/*.pdf"
  - "**/Dockerfile"
```

Matched against `~/.monad/workspace` (Monad's working area), evaluated at load and on every hot
reload. `paths` gates **L1 auto-load only** — the skill is still `/name`-invocable by the user
regardless of workspace contents.

### Compatibility (`compatibility`)

Advisory, **never blocks**. When `compatibility` reads as a semver range it's checked against the
running Monad version and a warning is logged if unmet; when it's free-form prose it's just
surfaced. Either way the skill loads — the operator decides whether to override:

```yaml
compatibility: ">=0.5.0"        # warns if running Monad is older, still loads
# compatibility: "needs network access and a GPU"   # free-form → surfaced as a note
```

The requirement is shown on `skills.list` items so clients can display it.

## How the model uses a skill (progressive disclosure)

1. **L1 — metadata** (always): every skill's `name` + `description` is listed in the system
   prompt (~100 tokens each).
2. **L2 — body** (on demand): when a task matches, the model calls the `skill` tool —
   `{"tool":"skill","input":{"name":"summarize-changes"}}` — to pull the full instructions.
3. **L3 — resources** (as needed): the model loads a bundled file by passing a relative path —
   `{"tool":"skill","input":{"name":"pdf-tips","file":"references/DETAIL.md"}}`. Paths are
   confined to the skill directory.

## Invoking a skill explicitly

Type `/<name> [args]` in any client (web `/` menu, or the message text). The skill body
becomes the turn, with `$ARGUMENTS`, `$0`, `$1`, … substituted from what follows the name.
`disable-model-invocation` skills are still explicitly invocable; `user-invocable: false`
skills are not.

## Referencing bundled files (`${SKILL_DIR}`)

A skill body can point at its own bundled resources by absolute path with `${SKILL_DIR}` (the
legacy alias `${CLAUDE_SKILL_DIR}` also works). This is resolved wherever the body is
surfaced — both when the model loads the skill and on `/name` invocation — so L3 scripts are
actually runnable:

```markdown
Run the linter: `python ${SKILL_DIR}/scripts/lint.py $ARGUMENTS`
Full rules are in `${SKILL_DIR}/references/STYLE.md`.
```

## Controlling which skills auto-load (`skills` config)

Every model-invocable skill's **description** is injected into the agent's context (L1) so the
model knows it exists. To keep that footprint under control, the operator decides which skills
auto-load, globally and per agent, in `config.json`:

```jsonc
{
  "skills": {
    "autoload": true,            // global master — false → no descriptions auto-load at all
    "disabled": ["legacy-thing"] // these never auto-load (globally)
  },
  "agent": {
    "agents": [{
      "id": "agt_…",
      "skills": { "autoload": true, "disabled": ["deep-research"] } // per-agent override
    }]
  }
}
```

A skill that doesn't auto-load is simply absent from the model's context and the `skill` tool —
it stays **`/name`-invocable** by the user. The per-agent `autoload` overrides the global master;
the denylists union. Changes hot-apply on save (no restart).

## Managing skills

- **List**: `monad skill` (CLI), `GET /v1/skills` (REST), or the `skills.list` JSON-RPC method.
- **New**: `monad skill new <name>` — scaffold a `SKILL.md` from a template.
- **Validate**: `monad skill validate <path>` — parse-check a skill folder or a repo of skills
  (offline; no daemon needed).
- **Install**: `monad skill install <local-path | git:owner/repo | git-url>` — copies validated
  skills into `~/.monad/skills/`. A running daemon picks them up via hot reload.
- **Remove**: `monad skill remove <name>` — delete a personal-scope skill.

A fresh `~/.monad` is seeded with a starter `summarize-changes` skill on first init (deleting it
keeps it gone — it won't come back on later restarts).
- **Web `/` menu**: type `/` in the chat input to filter and pick a skill.
- **Hot reload**: edits under `~/.monad/skills/` apply within the running session (debounced
  file watch). Adding the *first* skill to a daemon that booted with none needs a restart.

## Self-authoring (procedural memory)

The agent can write its own skills via the `skill_manage` tool — when it works out a reusable,
non-trivial workflow, it can save it as a skill for next time (create / edit / patch / delete,
plus bundled files). This is **high-risk**: it writes executable instruction files the agent
will later follow, so every write routes through the **oversight gate** (a human approves) and
is validated before landing. Approved skills go live immediately via hot reload. With no client
available to approve, writes fail closed.

## Examples

See [examples/skills/](../examples/skills/):

- `summarize-changes/` — model-invocable reference skill.
- `commit/` — user-only (`disable-model-invocation`) with `$ARGUMENTS`.
- `pdf-tips/` — bundles an L3 reference file the model loads on demand.

Copy one into `~/.monad/skills/` to try it.

## Dynamic context (opt-in)

A skill body may embed `` !`command` `` placeholders (at a line start or after whitespace).
When the daemon runs with `MONAD_SKILLS_SHELL_EXEC=1`, each is replaced at load time with the
command's output — e.g. `` Current diff: !`git diff HEAD` ``. This is **off by default**:
running shell from a `SKILL.md` is an escalation, so it requires explicit opt-in. Each command
has a 5-second render budget and failures become a visible marker. Rendering re-runs on hot
reload.

## Pre-approving tools (`allowed-tools`)

A skill can declare tools that should be **auto-approved at the oversight gate while it's
active** this turn — a skill becomes active when the model loads it (via the `skill` tool) or
you invoke it with `/name`:

```yaml
allowed-tools: file_read shell_exec
```

Patterns are matched against Monad tool *names*: exact (`file_read`), prefix glob (`file_*`), or a
argument-constrained `Bash(git:*)` form (the argument constraint is ignored — Monad gates per tool, not
per argument). A granted high-risk tool skips the human approval prompt; everything else still
goes through the gate. Grants are **turn-scoped** and only apply to tools a skill explicitly
lists, so the trust boundary is *which skills you install* — see Security.

## Forked execution (`context: fork`)

A skill with `context: fork` runs as an **isolated subagent**: a fresh agent with empty history
and the same tools/model/gate executes the skill body as its task, and only its **final result**
comes back — the multi-step work stays out of the main conversation. Useful for focused research
or long procedures.

```yaml
---
name: deep-research
description: Research a topic thoroughly. Use for multi-step investigation.
context: fork
---
Research $ARGUMENTS thoroughly and report findings with sources.
```

It forks whether the model auto-loads it (via the `skill` tool) or you invoke `/deep-research
<topic>`. The subagent runs under your session (so high-risk approvals still surface) but cannot
recurse into more skills, fork again, or self-author (`skill`, `skill_manage`, and
`agent_delegate` are withheld from it). Reuses the same engine as the `agent_delegate` tool.

### Capability tier (`tier`)

A fork skill can declare **which class of model** its subagent should run on, without naming a
vendor model — so the skill stays portable across deployments:

```yaml
---
name: deep-research
description: Research a topic thoroughly. Use for multi-step investigation.
context: fork
tier: power      # fast | smart | power
---
Research $ARGUMENTS thoroughly and report findings with sources.
```

The routing layer resolves the tier to a concrete model by **ranking your configured profiles
by blended price** (via the [models.dev](https://models.dev) catalog) and picking the cheapest
profile in that tier — `fast` = cheapest, `power` = priciest, `smart` = the middle (and the
default for anything unpriced). Ranking is *within your own configured set*, so it stays
vendor- and time-neutral; an operator `overrides` map wins when set. If no configured profile
matches the tier, the fork falls back to the agent's default model — it never fails to run.
`tier` is ignored without `context: fork`.

## Not yet supported

These imported frontmatter features are parsed-or-ignored but not yet enforced, pending
Monad infrastructure: per-skill `model`/`effort` overrides (Monad uses `tier` instead) and
`hooks` — which needs a hook subsystem Monad doesn't have yet.

## Security

Treat skills like installed software — a skill is executable instruction text from disk, the
same trust boundary as a provider atom (see [security-guidelines.md](../engineering/security-guidelines.md)).
Only install skills from sources you trust; audit `SKILL.md` and any bundled scripts. Note that
`allowed-tools` lets an active skill **bypass the human approval gate** for the tools it lists,
so a malicious skill that declares high-risk tools is dangerous — this is exactly why skill
*provenance* matters (operator-placed in `~/.monad/skills`, installed via `monad skill install`,
or self-authored through the gated `skill_manage` tool). Skill bodies are otherwise inert text
(the `skill` tool only returns content; it never executes bundled scripts on its own).

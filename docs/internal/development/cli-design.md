---
title: "CLI Design Conventions"
audience: "internal-developer"
description: "Code-level rules for the monad CLI surface: how commands are named, how they behave under flags, and where their data lives. The design intent these serve —."
---
Code-level rules for the `monad` CLI surface: how commands are **named**, how they
**behave** under flags, and where their **data** lives. The design intent these serve
— cross-platform parity and containing the agent — is in
[design principles](design-principles.md); the runtime and transport facts are in
[runtime architecture](../../internals/infra/runtime.md). This doc is the single source of truth for command naming
and CLI UX. Read it before adding or renaming a command.

The north star is the established command-line convention set: a user who knows
mainstream developer CLIs should be able to guess Monad's commands.

## 1. Naming

- **Resources use noun-verb.** `monad session list`, `monad provider add`. The noun is
  **singular** (`session`, `model`, `provider`, `credential`, `skill`), never plural.
- **Daemon lifecycle uses bare verbs.** `start`, `stop`, `restart`, `status`,
  `logs` — the conventional service-control shape. These act on the one daemon, so
  they need no noun.
- **One canonical name per action.** Pick the name an experienced CLI user would reach
  for first: `status` (not `health`/`ping`), `rm` for the canonical-ish destructive
  verb only where it is already universal. Don't ship two canonical names for one
  action.
- **Verbs are consistent across nouns.** `list` / `show` / `new` / `rm` / `add` /
  `remove` mean the same thing everywhere. Installable packs (`atom`, `skill`) use
  the package-manager triple `list` / `install` / `remove`.
- **Avoid name collisions across scopes.** A top-level command and a subcommand must
  not share a name with different semantics. Every destructive wipe is `purge <scope>`
  rather than a `reset` that would collide with `session reset`, which clears one
  session's messages.
- **Mutations are subcommands, not flags.** `monad usage reset` wipes the ledger;
  `monad usage --reset` would hide a destructive act inside a modifier.
- **A command declares its own subcommands.** `CommandDef.subcommands` is the single source shell
  completion reads. Adding a verb to a dispatcher without listing it there means the shell never
  offers it, which `cli-surface.test.ts` pins.
- **Monad does not broker third-party sign-in.** Where a command drives another vendor's CLI
  (`monad mesh`), report the sign-in state and name the command the user runs themselves. Proxying
  the login would mean handling someone else's credentials.
- **Non-streaming writes are replay-safe by default.** They derive an `Idempotency-Key` from the
  request so a retried script cannot double-post; see the CLI reference for the exact scope.
- **Every write prints its result under `--json`.** `out()` is suppressed in structured mode, so a
  command that only prints a human line emits nothing at all — which makes its result uncapturable.
  Pair every `out()` that reports an outcome with a `json()`.
- **Surface the daemon's error descriptor.** Unwrap failures through `requireTreatyData`, which
  raises a `DaemonError` carrying the daemon's `code`, `requestId`, and `retryable`. Never collapse a
  failure into a bare status string.
- **An unknown `--output` value is a usage error.** Silently falling back to human output would feed
  prose into a caller's JSON parser.

## 2. Friendly aliases

Beyond the canonical names, the CLI ships a **small, curated set of convenience
aliases** that match established command-line muscle memory and lower the barrier for
newcomers.

- Each alias points to exactly **one** canonical command and introduces no ambiguity.
- Aliases are **hidden from the top-level `monad --help`** to keep it scannable; they
  are listed under `monad help <canonical>` and in the table below.
- `CommandDef` separates `name` (canonical, rendered in help) from `aliases`
  (resolved by the dispatcher, omitted from the primary usage block). Completion
  scripts include both.

| Alias | Canonical | Why |
|-------|-----------|-----|
| `monad up` | bare `monad` (start + open web) | conventional service start |
| `monad down` | `monad stop` | conventional service stop |
| `monad ps` | `monad session list` | conventional process listing |
| `monad ls` | `monad session list` | conventional listing |
| `monad new [title]` | `monad session new` | top-level shortcut |
| `monad rm <id>` | `monad session rm` | conventional removal |
| `monad ask <text\|->` | `monad chat --no-stream` | one-shot Q&A |
| `monad models` | `monad model list` | plural = "list" |
| `monad agents` | `monad agent list` | plural = "list" |
| `s` / `m` | `session` / `model` | short group prefix |
| `cred` / `creds` | `credential` | short group prefix |
| `prov` | `provider` | short group prefix |
| `chan` | `channel` | short group prefix |
| `approvals` | `approval` | plural convenience |
| `commands` | `command` | plural convenience |
| `licenses` | `license` | plural convenience |

Every entry above must exist in `apps/cli/src/commands/shortcuts.ts` (or as an `aliases`
entry on the canonical command). The table and the registry are checked against each other
by `apps/cli/test/unit/cli-surface.test.ts`.

## 2b. Usage-table groups

Every visible command declares a `group` in its `CommandDef`, and the root usage table is
printed one section per group. The groups name what a reader is trying to do:

| Group | Contents |
|-------|----------|
| `daemon` | run and inspect Monad: `start`, `stop`, `restart`, `status`, `logs`, `doctor`, `update`, `version` |
| `work` | talk to agents and drive the team: `chat`, `session`, `agent`, `mesh`, `approval` |
| `configure` | set Monad up: `init`, `config`, `model`, `provider`, `credential`, `atom`, `skill`, `mcp`, `memory`, `command`, `channel`, `peer`, `remote`, `monadix`, `import`, `usage`, `license`, `completion`, `purge`, `tui` |

Grouping by *task* rather than by whether a command needs a live daemon is deliberate: a
reader scanning the table is choosing what to do, not deciding what is safe to run offline.
Whether a command is `local` remains a property of the command; it just is not the axis the
help text is organized around.

## 3. Global flags

Parsed centrally in `apps/cli/src/main.ts` and available to every command:

| Flag | Meaning |
|------|---------|
| `-h, --help` | Usage for the command (or root). |
| `-V, --version` | Print version. **Note:** `-V` is version so `-v` is free for verbose. |
| `-v, --verbose` | More detail; repeatable. `--debug` = max log level. |
| `-q, --quiet` | Suppress non-essential output; errors still print. |
| `--json` | Machine-readable JSON output (shorthand for `-o json`). |
| `-o, --output <fmt>` | Output format: `table` (default for lists), `json`, or `yaml`. |
| `--no-color` | Disable ANSI color (also honored via `NO_COLOR`). |
| `-y, --yes` / `--no-input` | Assume "yes" / never prompt — for non-interactive use. |
| `--port <n>` / `--host <h>` | Override the client's daemon connection for this call. |
| `--token <tok>` | Bearer token for `--host` remote-daemon connections. |

Exit codes (stable contract — scripts depend on them):

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic runtime error (daemon 5xx other than 502/503/504) |
| `2` | Usage error (bad flags/args; daemon 400, 404, 405, 422) |
| `3` | Configuration invalid (daemon 409, 412) |
| `4` | Daemon unreachable / not running (refused connection, or daemon 502/503/504) |

Classification comes from the failure's HTTP status (`exitCodeForHttpStatus`), never from
pattern-matching an error message — a message-based classifier made the same unreachable daemon
exit 4 from one command and 1 from another.

## 4. Output & scriptability

A command must be as useful in a pipe as in a terminal.

- **`--json` / `-o json|yaml|table`** selects the output format. `--json` is a
  shorthand for `-o json`. In structured modes there are no banners or ANSI color.
  Errors in structured mode go to **stderr** as `{"error":"…","code":<N>}` so
  `monad … --json | jq` never receives a corrupt stream on failure.
- **NDJSON streams.** `monad session watch --json` emits one raw JSON line per event
  (newline-delimited JSON), suitable for `… | jq -c '.type'` pipelines.
- **Auto-plain when not a TTY.** Color and spinners are gated on
  `process.stdout.isTTY && !NO_COLOR`. Piped output is never decorated.
- **stdin via `-`.** Where a command takes free text (`monad chat`,
  `monad session send`), a literal `-` argument reads the text from stdin:
  `echo "hi" | monad chat -`.
- **Streams to stdout, diagnostics to stderr.** Token streams, results, and structured
  payloads go to stdout; progress banners, warnings, and errors go to stderr.

## 5. Configuration vs. environment variables

This restates the rule in `AGENTS.md` for the CLI surface:

- **User settings live in `config.json`**, edited via `monad config set <key> <value>`
  (git-config style: `get` / `set` / `list` / `edit` / `path`). Do not add a new env
  var to expose a user setting.
- **Daemon behavior is `--flag` argv** (e.g. `--log`, `--stdio`, `--acp`), not env.
- **Env vars are reserved for bootstrap/override only:** `MONAD_HOME` (override-all
  data root), `MONAD_PORT` (dev per-worktree override), `NO_COLOR`. The `--port` /
  `--host` flags are the per-invocation client-connection override and take
  precedence over `MONAD_PORT`.

## 6. Data directories (XDG)

Paths are owned by `@monad/environment` (`paths.ts`); no command constructs paths itself.

- **Linux** follows the XDG Base Directory spec, split by category:
  - `$XDG_CONFIG_HOME/monad/` — `config.json`, `agents.json`, `mesh.json`, `approvals.json`,
    `auth.json`, and `credentials/`
  - `$XDG_DATA_HOME/monad/` — `atoms/`, `agents/`, `memory/`, `backup/`, `bin/`, `db/`
  - `$XDG_CACHE_HOME/monad/` — regenerable runtime output
  - `$XDG_STATE_HOME/monad/` — `logs/`; also the fallback for sockets/pid when
    `$XDG_RUNTIME_DIR` is unset
  - `$XDG_RUNTIME_DIR/monad/` — sockets, pid (when available)
- **macOS** uses `~/.monad`; **Windows** uses `%APPDATA%/monad`. Both keep the single-tree
  layout: `configs/`, `credentials/`, `runtime/`, `atoms/`, `agents/`, `db/`, `memory/`,
  `logs/`, `cache/`, `backup/`, `bin/`.
- **`MONAD_HOME` overrides everything** and collapses back to that single-tree layout —
  used for dev worktrees and explicit installs. A pinned root pointer file
  (`~/.monad/root`, `%APPDATA%/monad/root` on Windows) does the same for an explicit install.

Per [design principles](design-principles.md) §1, none of these per-OS branches
leak into command code — they are resolved once inside `paths.ts`.

# CLI design conventions

Code-level rules for the `monad` CLI surface: how commands are **named**, how they
**behave** under flags, and where their **data** lives. The design intent these serve
— cross-platform parity and containing the agent — is in
[design-principles.md](design-principles.md); the runtime/transport facts are in
[runtime.md](../internals/runtime.md). This doc is the single source of truth for command naming
and CLI UX. Read it before adding or renaming a command.

The north star is the convention set shared by `git`, `gh`, `docker`, `systemctl`,
and `brew`: a user who knows those tools should be able to guess Monad's commands.

## 1. Naming

- **Resources use noun-verb.** `monad session list`, `monad provider add` — like
  `gh pr list` / `docker container ls`. The noun is **singular** (`session`, `model`,
  `provider`, `credential`, `skill`), never plural.
- **Daemon lifecycle uses bare verbs.** `start`, `stop`, `restart`, `status`,
  `logs` — like `systemctl` / `docker`. These act on the one daemon, so they need no
  noun.
- **One canonical name per action.** Pick the name a `git`/`docker` user would reach
  for first: `status` (not `health`/`ping`), `rm` for the canonical-ish destructive
  verb only where it is already universal. Don't ship two canonical names for one
  action.
- **Verbs are consistent across nouns.** `list` / `show` / `new` / `rm` / `add` /
  `remove` mean the same thing everywhere. Installable packs (`atom`, `skill`) use
  the package-manager triple `list` / `install` / `remove`.
- **Avoid name collisions across scopes.** A top-level command and a subcommand must
  not share a name with different semantics (this is why the destructive home-wipe is
  `purge`, distinct from `session reset`, which clears one session's messages).

## 2. Friendly aliases

Beyond the canonical names, the CLI ships a **small, curated set of convenience
aliases** that match docker/git muscle memory and lower the barrier for newcomers.

- Each alias points to exactly **one** canonical command and introduces no ambiguity.
- Aliases are **hidden from the top-level `monad --help`** to keep it scannable; they
  are listed under `monad help <canonical>` and in the table below.
- `CommandDef` separates `name` (canonical, rendered in help) from `aliases`
  (resolved by the dispatcher, omitted from the primary usage block). Completion
  scripts include both.

| Alias | Canonical | Origin |
|-------|-----------|--------|
| `monad up` | bare `monad` (start + open web) | docker compose |
| `monad down` | `monad stop` | docker compose |
| `monad ps` | `monad session list` | `docker ps` |
| `monad ls` | `monad session list` | Unix `ls` |
| `monad new [title]` | `monad session new` | top-level shortcut |
| `monad rm <id>` | `monad session rm` | Unix `rm` |
| `monad ask <text\|->` | `monad chat --no-stream` | one-shot Q&A |
| `monad models` | `monad model list` | plural = "list" |
| `s` / `m` | `session` / `model` | short group prefix |
| `creds` / `prov` | `credential` / `provider` | short group prefix |

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
| `1` | Generic runtime error |
| `2` | Usage error (bad flags/args) |
| `3` | Configuration invalid |
| `4` | Daemon unreachable / not running |

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
  - `$XDG_CONFIG_HOME/monad/` — `config.json`, `auth.json`
  - `$XDG_DATA_HOME/monad/` — `atoms/`, `agents/`, the sqlite database
  - `$XDG_CACHE_HOME/monad/` — regenerable schema/catalog, logs
  - `$XDG_STATE_HOME/monad/` — durable state (`schedules.json`); also the fallback
    for sockets/pid when `$XDG_RUNTIME_DIR` is unset
  - `$XDG_RUNTIME_DIR/monad/` — sockets, pid (when available)
- **macOS** uses `~/.monad`; **Windows** uses `%APPDATA%/monad`.
- **`MONAD_HOME` overrides everything** and collapses back to the single-tree layout
  (`$MONAD_HOME/configs`, `$MONAD_HOME/runtime`, …) — used for dev worktrees and
  explicit installs.
- On first run, an existing legacy `~/.monad` on Linux is **migrated by moving** each
  subdir to its XDG destination; the source is never deleted until all moves succeed.

Per [design-principles.md](design-principles.md) §1, none of these per-OS branches
leak into command code — they are resolved once inside `paths.ts`.

---
title: "CLI Reference"
description: "Use the Monad CLI to operate the daemon, sessions, projects, models, channels, approvals, extensions, and automation."
---
The `monad` command is a thin client over the local daemon: it starts the daemon when needed, talks to it over the configured transport, and exposes every shipped operation in a scriptable form.

## Quick start

```sh
monad                # start the daemon (if needed) and open the web UI
monad chat "hello"   # create a session and stream a reply in the terminal
monad status         # check whether the daemon is running
monad stop           # stop the daemon
```

Bare `monad` (or its alias `monad up`) starts the daemon, then opens the browser
setup flow on first run or the web UI on later runs. `monad help` prints the usage table; `monad help <command>`
prints one command's synopsis, aliases, and flags.

## Global flags

Available on every command:

| Flag | Meaning |
|------|---------|
| `-h, --help` | Usage for the command (or the root usage table) |
| `-V, --version` | Print the version |
| `-v, --verbose` | More detail; repeatable (`-v -v` enables debug logging) |
| `--debug` | Maximum log level |
| `-q, --quiet` | Suppress non-essential output; errors still print |
| `--json` | Machine-readable JSON output (shorthand for `-o json`) |
| `-o, --output <fmt>` | Output format: `table` (default), `json`, or `yaml` |
| `--no-color` | Disable ANSI color (also honored via `NO_COLOR`) |
| `-y, --yes` / `--no-input` | Assume yes / never prompt — for non-interactive use |
| `--port <n>` / `--host <h>` | Override the daemon connection for this call |
| `--token <tok>` | Bearer token for `--host` remote-daemon connections (prefer `--token-file`) |
| `--token-file <path>` | Read the bearer token from a file instead of argv |
| `--force` | Continue past a daemon/client version mismatch on remote connections |

Environment variables are bootstrap-only: `MONAD_PORT` (daemon port override, shared by
daemon and clients) and `MONAD_HOME` (data root). Everything else lives in
`config.json` — see `monad config`.

## Daemon lifecycle

```text
monad start                  start the daemon
monad stop                   stop the running daemon
monad restart                restart the daemon
monad status                 check whether the daemon is running
monad logs [-f] [-n <lines>] show the daemon log (-f to follow, default 200 lines)
monad doctor                 diagnose configuration, connection, and version problems
monad version                print the Monad version
monad upgrade [rollback]     check for and apply updates; rollback reverts the last one
monad remote tls <renew|show|trust> manage the daemon TLS certificate
```

`monad upgrade` accepts `--check` (report only), `--channel <stable|beta|nightly>`,
`--notes` (release notes), and `--prune-backups`.

## Setup and configuration

```text
monad init                                        interactive setup (home directory + model provider)
monad config <get|set|list|path|edit> [key] [value]  read or write configuration (secrets masked)
monad import settings|doctor --from <source> --path <path> [--apply]
                                                  preview or import settings from Codex, Claude Code, Hermes, or OpenClaw
monad purge <sessions|config|auth|all>            permanently delete stored state; `all` wipes and
                                                  rebuilds Monad home (double confirmation)
monad completion <bash|zsh|fish|install>          output a shell completion script
monad license list                                    list third-party package licenses
```

Example:

```sh
monad config set network.transport tcp
monad purge sessions --keep-last 5
```

## Chat and sessions

```text
monad chat [text|-] [--session <id>] [--no-stream]   talk to your agent (interactive with no message)
monad tui                                            open the interactive TUI
```

`monad chat` streams the reply by default; `-` reads the message from stdin:

```sh
echo "summarize this diff" | monad chat -
```

With no message on a TTY, `chat` opens an interactive loop: `/exit` (or `/quit`) leaves it, Ctrl-C
interrupts a streaming reply and a second Ctrl-C leaves. Every other `/name` line is sent through to
the daemon's slash-command handler, and a bare `exit` is sent as an ordinary message.

Both `chat` and `session send` attach local files with repeated `--file <path>`. Text-like files are
sent as readable text, images as images, everything else as a binary attachment; the per-message
count and size caps come from the protocol, and an unreadable path fails before the turn is posted.

`session watch` runs until Ctrl-C by default. In a script give it a stop condition:
`--until <eventType>` (repeatable) ends the stream when that event arrives, and `--timeout <s>`
bounds the wait and exits non-zero so a pipeline can tell "never arrived" apart from "arrived":

```sh
monad session send "$ID" "run the migration" --detach
monad session watch "$ID" --until session.message.completed --timeout 300 --json | tail -1
```

`session messages` is the read side of a transcript — `session show` returns metadata and
`session watch` only sees events published while it is attached, so this is how a `--detach` turn's
answer is collected afterwards.

Session operations use the `session` noun (alias `s`):

```text
monad session new <title>                        create a session, print its id
monad session list [state] [--attention]         list sessions (aliases: ls); --attention shows
                                                 only those waiting on a human, and what they need
monad session show <sessionId>                   show one session as JSON
monad session send <sessionId> <text|-> [--file <path>] [--no-stream] [--detach]
                                                 send a message (--detach fires and forgets)
monad session messages <sessionId> [--limit <n>] [--before <messageId>] [--include-inactive]
                                                 read the transcript back
monad session watch <sessionId> [--until <eventType>] [--timeout <s>]
                                                 stream a session's events (alias: tail)
monad session search [--mode <m>] <query>        search history (keyword | semantic | hybrid)
monad session plan <list|add|update|rm> <sessionId> …    view and edit the shared durable to-do plan
monad session branch <sessionId> [title] [atMessageId]   copy history into a new session
monad session restore <sessionId> <toMessageId>  rewind to a message checkpoint
monad session reset <sessionId>                  clear messages, keep the session
monad session abort <sessionId>                  cancel an in-flight run
monad session rm <sessionId>                     delete a session and its data
```

## Models, providers, and credentials

```text
monad model <list|set|rm|use|test> [arg]             manage model profiles and the default
monad provider <list|set|rm|models> [arg]            manage model providers
monad credential <list|add|rm|test> <providerId> [arg]       manage provider credentials
```

- `monad model use [alias]` gets or sets the default profile; `monad model test <json>`
  probes a provider and key without saving.
- `monad provider models <id>` lists a provider's model catalog.
- Secrets never leave the daemon: `credential list` shows only a token preview.

## Skills, atoms, and MCP

```text
monad skill <list|search|install|update|remove|enable|disable|new|validate> [arg]   manage skills
monad atom <list|install|update|remove|scaffold|pack> [arg]          manage and package atom packs
monad mcp <list|status|add|remove|enable|disable|authorize|reconnect|search> [name] [command…|--url <url>]
                                                                     manage hot MCP servers
monad command list                                                       list available slash commands
```

`monad skill install` accepts a local path, a git URL, `github:owner/repo`, or a bare
registry name; `--scope <runtime|global|atom-pack|agent>` filters `skill list`.
`skill disable <name>` removes a skill from the agent entirely; `skill disable <name>
--autoload-only` keeps it `/name`-invocable but drops its description from the model's context,
which is the knob that controls what every turn pays for.
`monad mcp add <name> <command> [args…]` registers a stdio server;
`--url <url>` registers a remote HTTP server. OAuth servers configured via
`config.json` or the web UI are driven with `mcp authorize` and `mcp reconnect`.

## Channels and peers

```text
monad channel <list|status|add|token|enable|disable|rm> [arg]
                                          manage channels
monad peer <list|add|token|enable|disable|rm> [arg]
                                          manage peer daemons for task delegation
monad monadix <login|enable|disable|status>
                                          connect to the Monadix collaboration network
```

`channel add` takes `--label`, `--agent`, and `--id`; `peer add` takes `--label`,
`--agent`, and `--id`.

## The agent team

`monad agent` is the team roster — the same agents the web UI configures, driven headlessly:

```text
monad agent list                          list agents and mark the default
monad agent show <agentId|name>           show one agent
monad agent new <name> [--model <alias>] [--framework <f>] [--prompt <text>]
monad agent set <agentId|name> [--name <n>] [--model <alias>] [--framework <f>]
monad agent prompt <agentId|name> [text|-]  read or replace the AGENT.md body
monad agent use [agentId|name]            get or set the default agent
monad agent rm <agentId|name>             delete an agent
```

Every subcommand takes an agent id or its name. `agent prompt` reads the body from stdin
with `-`.

## Third-party agent runtimes

`monad mesh` drives native CLI agents (codex, claude, …) running as team members under a
transcript. Per-session verbs need the transcript they belong to; `--session <sessionId>`
supplies it, and is looked up automatically when the runtime is still live.

```text
monad mesh list                           list live runtimes daemon-wide
monad mesh agents                         list configured third-party agents
monad mesh auth <agentName>               report a provider CLI's sign-in state
monad mesh start <agentName> --session <sessionId> [--cwd <path>]
monad mesh show <meshSessionId>           show one runtime's lifecycle, activity, connection
monad mesh watch <meshSessionId> [--raw]  follow the runtime's output until Ctrl-C
monad mesh input <meshSessionId> <text|-> queue a turn
monad mesh steer <meshSessionId> <text|-> interrupt the current turn with new direction
monad mesh interrupt <meshSessionId>      interrupt without new input
monad mesh stop <meshSessionId>           stop the runtime
monad mesh approve|deny <meshSessionId> <requestId> [--reason <text>]
monad mesh usage [meshSessionId]          provider overview, or one runtime's token counters
```

**Sign-in is not brokered.** Third-party agents are separate products with their own credentials, so Monad
never proxies their login. `mesh start` checks the provider's sign-in state first and refuses to
spawn a runtime that would only sit at a login prompt; sign in with that agent's own CLI and try
again. A provider that exposes no probe reports `unknown` and still starts.

`mesh watch` follows the neutral projection every Monad surface renders — one line per observation
event. `--raw` switches to the verbatim provider frames (a diagnostic surface: exactly the bytes the
provider emitted). Both resume from the last seen cursor after a dropped connection, and `--json`
emits NDJSON.

## Memory

Read side of layered memory — what the agent will actually recall:

```text
monad memory status                       backend and readiness
monad memory facts --scope <kind>:<id>    stored facts for one scope
monad memory graph [--scope <kind>:<id>]  entity graph as from/relation/to rows
monad memory laws  [--scope <kind>:<id>]  inferred laws, flagging stale and contradicted ones
```

`<kind>` is `session`, `agent`, `project`, or `global`; `<id>` is the matching id, or `*` for
global. A law that is stale (its grounding is gone) or contradicted by a current fact is suppressed
from recall — both are flagged so you can see why a memory is not being applied.

## Approvals

One noun covers every point where an agent is blocked on a human — the pending queue, the
answer, and the rules that stop it recurring:

```text
monad approval list [--session <sessionId>]   what is waiting on you right now
monad approval allow <requestId> [--scope <once|session|agent|global>] [--reason <text>]
monad approval deny <requestId> [--scope <s>] [--reason <text>]
monad approval answer <interactionId> [--value key=value ...]
monad approval rules                      remembered allow/deny rules
monad approval revoke <ruleId>            remove one rule
monad approval clear [--scope <s>] [--agent <id>]
```

`approval list` returns both planes: high-risk tool calls held at the oversight gate (each with
the `requestId` that `allow`/`deny` resolves) and host interactions waiting for a presenter.
`approval answer` prompts interactively on a TTY; repeated `--value key=value` answers each field
non-interactively instead.

## Usage

```text
monad usage show [--by-day] [--by-category]   cumulative token and cost usage
monad usage reset                             wipe the ledger
```

## Aliases

Convenience aliases match established command-line muscle memory. They are hidden from the top-level
usage table but always resolvable:

| Alias | Canonical |
|-------|-----------|
| `monad up` | bare `monad` (start + open web) |
| `monad down` | `monad stop` |
| `monad ps` / `monad ls` | `monad session list` |
| `monad new <title>` | `monad session new` |
| `monad rm <id>` | `monad session rm` |
| `monad ask <text\|->` | `monad chat --no-stream` |
| `monad models` | `monad model list` |
| `monad agents` | `monad agent list` |
| `s` / `m` | `session` / `model` |
| `cred` / `creds` | `credential` |
| `prov` | `provider` |
| `chan` | `channel` |
| `approvals` | `approval` |
| `commands` | `command` |
| `licenses` | `license` |

## Secrets

`config` reads `config.json` directly so it keeps working with the daemon down, which means the
daemon's own credential masking does not apply — so the CLI masks on its own. `config get`,
`config list`, and the value `config set` echoes back all print secrets as `••••<last4>`:

```text
openaiCompat.token = ••••bc92
```

`--reveal` prints them in the clear, but only to an interactive terminal: a redirect into a file, a
pipe into a log, and a `--json` capture are exactly how a secret escapes, and all three are the
non-TTY case.

Never pass a secret as an argument — argv is readable by every local user through `ps` and is
recorded in shell history. Use the stdin and file forms:

```sh
monad credential add openrouter - < credential.json
monad model test - < probe.json
monad status --host monad.example.com --token-file ~/.monad/remote-token
```

## Retries and idempotency

Every non-streaming write derives an `Idempotency-Key` from the request itself, so re-running the
identical command inside the daemon's five-minute window replays the first response instead of
creating a second session or billing a second turn. Change any part of the request and the key
changes with it, so a genuinely new call is never swallowed. This covers `session new`,
`session send --detach`, `session send --no-stream`, and one-shot `chat`; the streaming path posts
through the inline SSE route, which the daemon deliberately keeps outside the ledger, and an
interactive `chat` REPL sends no key at all (repeating a line there is a real second turn).

Pass `--idempotency-key <key>` to scope replays yourself. Keys are `idem_` followed by exactly 12
alphanumerics.

## Errors

A failed daemon call carries the daemon's own descriptor, not just an HTTP status. In `--json` mode
the error frame on stderr includes it:

```json
{"error":"Rate limit exceeded","status":429,"code":"RATE_LIMITED","requestId":"req_...","retryable":true,"exitCode":1}
```

`requestId` matches the daemon's log entry for the same request, and `retryable` says whether
retrying can help. A well-formed id for something that does not exist is a `404`/`NOT_FOUND` that
names the missing id — distinct from a `400`/`VALIDATION` for a malformed one. `exitCode` is the process exit code; `code` is the daemon's stable error code —
they are different things and no longer share a field name.

## Exit codes

Stable contract — scripts depend on these:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic runtime error (daemon 5xx other than 502/503/504) |
| `2` | Usage error (bad flags or arguments; daemon 400, 404, 405, 422) |
| `3` | Configuration invalid (daemon 409, 412) |
| `4` | Daemon unreachable or not running (refused connection, or daemon 502, 503, 504) |

A daemon failure is classified by its HTTP status, so the same condition always exits the same way
whichever command reported it.

## Scripting

Structured output goes to stdout; diagnostics and errors go to stderr. In `--json`
mode a failure emits `{"error":"…","code":<N>}` on stderr, so a piped stream is never
corrupted:

```sh
# List session ids
monad session list --json | jq -r '.[].id'

# Tail a session as NDJSON, one event per line
monad session watch ses_abc123 --json | jq -c 'select(.type == "session.message.completed")'

# One-shot question from a pipe
git diff | monad ask -

# Script against a remote daemon
monad status --host monad.example.com --token-file ~/.monad/remote-token --json
```

Color and spinners are disabled automatically when stdout is not a TTY or `NO_COLOR`
is set. Use `-y` / `--no-input` in CI so no command ever blocks on a prompt.

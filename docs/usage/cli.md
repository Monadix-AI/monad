# CLI reference

The `monad` command is a thin client over the local daemon: it starts the daemon when
needed, talks to it over the configured transport, and exposes every operation in a
scriptable form. Naming and behavior conventions are specified in
[cli-design.md](../engineering/cli-design.md); this page is the user-facing reference
for what ships today.

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
| `--token <tok>` | Bearer token for `--host` remote-daemon connections |
| `--force` | Continue past a daemon/client version mismatch on remote connections |

Environment variables are bootstrap-only: `MONAD_PORT` (daemon port override, shared by
daemon and clients) and `MONAD_HOME` (data root). Everything else lives in
`config.json` — see `monad config`.

## Daemon lifecycle

```
monad start                  start the daemon
monad stop                   stop the running daemon
monad restart                restart the daemon
monad status                 check whether the daemon is running
monad logs [-f] [-n <lines>] show the daemon log (-f to follow, default 200 lines)
monad doctor                 diagnose configuration, connection, and version problems
monad version                print the Monad version
monad upgrade [rollback]     check for and apply updates; rollback reverts the last one
monad tls <renew|show|trust> manage the daemon TLS certificate
monad pair                   enable remote access and print a QR code for mobile pairing
```

`monad upgrade` accepts `--check` (report only), `--channel <stable|beta|nightly>`,
`--changelog`, and `--prune-backups`. `monad pair` accepts `--rotate`, `--show-token`,
and `--mode <lan|overlay>`.

## Setup and configuration

```
monad init                                        interactive setup (home directory + model provider)
monad config <get|set|list|path|edit> [key] [value]  read or write configuration
monad import settings|doctor --from <source> --path <path> [--apply]
                                                  preview or import settings from Codex, Claude Code, Hermes, or OpenClaw
monad reset <sessions|config|auth|usage|all>      selectively reset parts of the system
monad purge                                       wipe and rebuild Monad home (destructive; double confirmation)
monad completion <bash|zsh|fish|install>          output a shell completion script
monad licenses                                    list third-party package licenses
```

Example:

```sh
monad config set network.transport tcp
monad reset sessions --keep-last 5
```

## Chat and sessions

```
monad chat [text|-] [--session <id>] [--no-stream]   talk to your agent (interactive with no message)
monad tui                                            open the interactive TUI
```

`monad chat` streams the reply by default; `-` reads the message from stdin:

```sh
echo "summarize this diff" | monad chat -
```

Session operations use the `session` noun (alias `s`):

```
monad session new <title>                        create a session, print its id
monad session list [state]                       list sessions (aliases: ls)
monad session show <sessionId>                   show one session as JSON
monad session send <sessionId> <text|-> [--no-stream] [--detach]
                                                 send a message (--detach fires and forgets)
monad session watch <sessionId>                  stream a session's events (alias: tail)
monad session search [--mode <m>] <query>        search history (keyword | semantic | hybrid)
monad session branch <sessionId> [title] [atMessageId]   copy history into a new session
monad session restore <sessionId> <toMessageId>  rewind to a message checkpoint
monad session reset <sessionId>                  clear messages, keep the session
monad session abort <sessionId>                  cancel an in-flight run
monad session rm <sessionId>                     delete a session and its data
```

## Models, providers, and credentials

```
monad model <list|set|rm|use|test> [arg]             manage model profiles and the default
monad provider <list|set|remove|models> [arg]        manage model providers
monad credential <list|add|remove|test> <providerId> [arg]   manage provider credentials
```

- `monad model use [alias]` gets or sets the default profile; `monad model test <json>`
  probes a provider and key without saving.
- `monad provider models <id>` lists a provider's model catalog.
- Secrets never leave the daemon: `credential list` shows only a token preview.

## Skills, atoms, and MCP

```
monad skill <list|search|install|update|remove|new|validate> [arg]   manage skills
monad atom <list|install|update|remove|scaffold> [arg]               manage atom packs
monad mcp <list|status|add|remove|enable|disable|authorize|reconnect|search> [name] [command…|--url <url>]
                                                                     manage hot MCP servers
monad commands                                                       list available slash commands
```

`monad skill install` accepts a local path, a git URL, `github:owner/repo`, or a bare
registry name; `--scope <runtime|global|atom-pack|agent>` filters `skill list`.
`monad mcp add <name> <command> [args…]` registers a stdio server;
`--url <url>` registers a remote HTTP server. OAuth servers configured via
`config.json` or the web UI are driven with `mcp authorize` and `mcp reconnect`.

## Channels and peers

```
monad channel <list|status|add|token|pairings|pair|enable|disable|remove> [arg]
                                          manage channels and approve pairing requests
monad peer <list|add|token|enable|disable|remove> [arg]
                                          manage peer daemons for task delegation
```

`channel add` takes `--label`, `--agent`, `--id`, and
`--policy <allowlist|pairing|open|disabled>`; `peer add` takes `--label`, `--agent`,
and `--id`.

## Approvals and interactions

```
monad approvals <list|revoke <id>|clear [--scope <s>] [--agent <id>]>
                                          manage remembered tool-approval rules
monad interaction answer <id>             answer a pending host interaction
```

When a command runs interactively, pending approval requests from the daemon surface
inline in the terminal.

## Agent collaboration

```
monad project <post|ask|read|inbox>       post to or read the current Workplace Project room
monad agent <send|read>                   direct private messages with an agent or human
monad runtime info                        show the managed external agent runtime binding
monad usage [--reset] [--by-day] [--by-category]   show cumulative token/cost usage
```

`project post` and `agent send` read from stdin with `-` and attach local files with
repeated `--file <path>` flags.

## Aliases

Convenience aliases match git/docker muscle memory. They are hidden from the top-level
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
| `s` / `m` | `session` / `model` |
| `cred` / `creds` | `credential` |
| `prov` | `provider` |
| `chan` | `channel` |
| `approval` | `approvals` |

## Exit codes

Stable contract — scripts depend on these:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic runtime error |
| `2` | Usage error (bad flags or arguments) |
| `3` | Configuration invalid |
| `4` | Daemon unreachable or not running |

## Scripting

Structured output goes to stdout; diagnostics and errors go to stderr. In `--json`
mode a failure emits `{"error":"…","code":<N>}` on stderr, so a piped stream is never
corrupted:

```sh
# List session ids
monad session list --json | jq -r '.[].id'

# Tail a session as NDJSON, one event per line
monad session watch ses_abc123 --json | jq -c 'select(.type == "agent.message")'

# One-shot question from a pipe
git diff | monad ask -

# Script against a remote daemon
monad status --host monad.example.com --token "$TOKEN" --json
```

Color and spinners are disabled automatically when stdout is not a TTY or `NO_COLOR`
is set. Use `-y` / `--no-input` in CI so no command ever blocks on a prompt.

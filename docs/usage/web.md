---
title: "The Web UI"
sidebarTitle: "Web UI"
description: "Open Monad's browser client, navigate the workspace and Studio, and know which operations only exist there."
keywords: ["Monad web UI", "Studio", "workspace", "browser client", "daemon control UI"]
---
The web UI is one client of the daemon, not a second source of truth. Everything it
shows lives in the daemon, so a session started from the CLI appears in the browser and
a change made in the browser is visible to `monad` commands immediately. The rest of
this documentation drives Monad from the CLI; this page is the map of what the browser
adds on top.

## Open it

```bash
monad          # start the daemon if needed and open the browser
monad up       # same thing, explicit
monad status   # print the address the daemon is actually serving
```

The web UI is served over TCP loopback only — a browser cannot reach the Unix socket, so
the address is always `http://127.0.0.1:<port>` even when `network.transport` is `uds`.

On a fresh install the browser opens the setup flow (`/init`): pick a model provider,
enter its credential, test the connection, and choose a default model. `monad init` is
the same flow in the terminal; either one completes setup.

## Layout

| Route | What it is |
| --- | --- |
| `/` | Workspace home: start a session, pick the agent that handles it, resume recent work |
| `/sessions/<sessionId>` | One transcript with streaming output, tool cards, and approval cards |
| `/inbox` | Everything waiting on a human across sessions: approvals, questions, mentions |
| `/workspace/<projectId>` | A project: its sessions, members, and settings |
| `/studio/<section>` | Configuration, grouped by what owns the setting |
| `/settings/<section>` | Application settings: connection, profile, experience, licenses, system |

Typing `/` in the composer opens the command and skill menu — the same commands the CLI
and IM channels dispatch.

## Studio

Studio is the configuration surface, and its sidebar follows the product boundary:

| Group | Sections |
| --- | --- |
| **Monad Mesh** | Mesh overview, Mesh agents |
| **Monad Agent Runtime** | Runtime overview, Models and providers, Monad agents, Credentials, Capabilities, ACP delegates, Memory, Safety, Hooks |
| **System** | Channels, Import, Atom Packs |

Capabilities holds tools, MCP servers, and skills in one panel. Memory folds facts, the
knowledge graph, and mem0 into tabs. Sandbox backends live under `/studio/sandbox`, and
approval rules under `/studio/approvals`.

## What only the web UI can do

Most work has a CLI equivalent, and the CLI is the scriptable surface. These do not:

| Capability | Why it is browser-only |
| --- | --- |
| Workplace Experiences | A web-only rendering layer over daemon state — see [workplace-experiences.md](/internals/agent-team-runtime/workplace-experiences) |
| Interactive third-party agent sign-in | The provider's own login runs in an embedded terminal; `monad mesh auth` only reports the state |
| WhatsApp pairing | The QR code has to be scanned from a screen |
| Agent Runtime Credentials | Managed through Studio and `/v1/settings/credentials`; there is no `monad` command for them yet |
| Enabling remote access | Settings → Connection generates the bearer token and turns on TLS in one write — see [remote access](/guides/remote-access) |
| Atom Pack install consent | Reviewing a pack's declared atoms before granting them |

Conversely, some things are CLI-only or CLI-first: scripting with `--json` and NDJSON
event streams, `monad doctor`, `monad logs`, `monad purge`, `monad upgrade`, and every
non-interactive automation path. See the [CLI reference](/usage/cli).

## The terminal alternative

`monad tui` is a keyboard-first client with the same product map. It renders chat,
projects, inbox, and settings, and degrades gracefully where a diagram or visual editor
would be required. See [Terminal UI](/usage/tui).

## When the UI does not load

The daemon serves the browser over the loopback port even when the CLI is on the Unix
socket, so check the port rather than the transport:

```bash
monad status
monad logs -n 200
```

More symptoms and fixes: [Troubleshooting](/usage/troubleshooting).

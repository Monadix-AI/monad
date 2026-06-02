---
title: "Sessions, Agents, and Approvals"
sidebarTitle: "Sessions and Approvals"
description: "Create, resume, branch, restore, and observe durable sessions while managing agents and approvals."
keywords: ["Monad sessions", "agent approvals", "branch session", "restore session", "OperationSource"]
---
import { LocalRuntimeData } from '/snippets/local-runtime-data.mdx';

How to work with Monad's core objects day to day: create and continue sessions,
branch and rewind them, answer approval requests, and choose which agent handles a
conversation. For one-paragraph definitions of each concept, see
[concepts.md](/concepts); this guide is the operational view.

## What a session is

A session is one persistent conversation thread between you and an agent. It lives
in the daemon, not in any client: the transcript, tool events, and resume state
survive daemon restarts, and every client — web UI, CLI, TUI, editor, IM channel —
sees the same session. Closing a browser tab or terminal never loses a
conversation.

Each session records immutable `OperationSource` provenance describing the surface,
client, and server-stamped semantic transport that created it — see
[operation-source.md](/internals/agent-runtime/operation-source).

Standalone chats and project sessions share this contract. A project is the durable
workspace and member environment; each conversation under it is a separate Session
with its own transcript, member bindings, lifecycle, and optional Plan. See
[project-sessions.md](/internals/agent-team-runtime/project-sessions).

## Creating and continuing a session

`monad chat` is the conversational entry point:

```sh
monad chat "what changed in the repo today?"   # one turn, streams the reply
monad chat                                     # interactive loop on a TTY
monad chat --session <sessionId>               # resume an existing session
echo "summarize this" | monad chat -           # read the message from stdin
```

For scripting, the `session` commands give finer control:

```sh
monad session new <title>                      # create, print the session id
monad session send <sessionId> <text|->        # send into a session (--no-stream, --detach)
monad session list                             # list sessions (aliases: monad ps, monad ls)
monad session show <sessionId>                 # one session as JSON
monad session watch <sessionId>                # stream events live (--json emits NDJSON)
```

The same sessions appear in the browser (`monad`, then the workspace home) and in
`monad tui`; the composer there picks the agent before the first message. See
[the web UI](/usage/web).

Inside any conversation, typing `/` opens the command and skill menu: `/new`
starts a fresh session, `/sessions` lists them, `/switch` changes the active one,
and `/handoff` summarizes the current conversation and continues it in a new
session. The same commands work from every surface, including IM channels. See
[skills.md](/usage/skills) for the skill side of the `/` menu.

## Branching and restoring

Use these when you want to explore without losing the original thread:

- **Branch** copies history through the selected message into a new independent
  session. The source is untouched, and later edits to either session do not
  affect the other. Use it to try a different approach, ask a side question with
  full context, or compare two directions.
- **Restore** rewinds a session in place to an earlier message checkpoint,
  discarding everything after it. Use it when a conversation went off the rails
  and you want to redo from a known-good point. Unlike branch, this rewrites the
  session itself, so the web UI asks you to confirm.

```sh
monad session branch <sessionId> [title] [atMessageId]   # copy history into a new session
monad session restore <sessionId> <toMessageId>          # rewind to a checkpoint
```

In the browser, hover a settled message to find the same two actions; the new session
includes a collapsible source-history boundary.

Branch requests are subject to the same server-side transport containment as session
writes. The persisted `OperationSource` is not a client-configurable permission list;
see [operation-source.md](/internals/agent-runtime/operation-source).

## Approvals

When the agent wants to run a high-risk tool — shell commands, file writes
outside its sandbox, self-authored skills, and similar — the call pauses at the
approval gate until a human answers. The turn blocks; nothing executes while the
request is pending.

From the CLI, `monad approval list` shows what is waiting and `monad approval allow`
or `monad approval deny` answers it; `--scope <once|session|agent|global>` decides how
long the decision is remembered. In the browser and TUI the same request appears as an
approval card in the transcript, naming the tool and its input, with these choices:

- **Approve once** — allow this single call.
- **Approve for this session** — remember the decision for the rest of the session.
- **Always allow** — remember it globally. Tools that control your real machine
  (host-control) never offer this scope; they can be allowed at most per session.
- **Deny** — refuse the call; the agent is told and continues without it.

If nobody answers, the request times out and is denied automatically (2 minutes
by default). With no client connected to approve, high-risk calls fail closed —
they are denied, never silently run.

Remembered decisions become rules you can inspect and undo:

```sh
monad approval rules                            # show remembered allow/deny rules
monad approval revoke <id>                     # remove one rule
monad approval clear [--scope <s>] [--agent <id>]
```

Native CLI agents run their own approval
prompts; Monad only decides whether those run unattended or are relayed to you —
see [native-cli-approvals.md](/usage/native-cli-approvals).

## Agents

An agent is the configured persona a session runs with: its name, system prompt,
model profile, skill set, tool exposure, sandbox mode, and limits. One daemon can
define many agents; each session binds to exactly one at creation. If you don't
pick one, the daemon uses the default agent (`agent.defaultAgentId` in
`agents.json`).

Agents are defined under `agent.agents` in `agents.json`. Drive the roster from the
CLI:

```sh
monad agent list                                # roster, with the default marked
monad agent new <name> --model <alias>          # add one
monad agent set <agentId|name> --model <alias>  # change it
monad agent prompt <agentId|name> -             # replace AGENT.md from stdin
monad agent use <agentId|name>                  # set the default
```

**Studio → Monad agents** edits the same records. Per agent you can set, among other
things:

- `modelAlias` and per-role model overrides — e.g. a cheaper model for memory work.
- `skills` — per-agent skill auto-load overrides (see [skills.md](/usage/skills)).
- `atoms` — which tools and capabilities the agent may use.
- `sandbox`, `maxTurns`, `maxBudgetUsd` — containment and spending limits.

To use a specific agent, bind it when the session is created — the `agentId` field on
the create-session API, or the agent picker in the browser composer. A session's agent
is fixed at creation; to move a conversation to a different setup, use `/handoff` or
branch into a new session created with the other agent.

## Watching sessions across clients

Because sessions live in the daemon, any client can observe a session another
client is driving. A conversation started from Telegram shows up in the web UI's
session list, and its replies stream there live; `monad session watch <id>` tails
the same events in a terminal. Selected write and branch paths currently apply a
server-side semantic-transport containment check, so observing a session does not
imply that every ingress may mutate it. This is an explicit temporary architecture
exception, not a configurable origin policy; see
[operation-source.md](/internals/agent-runtime/operation-source).

## Where your data lives

<LocalRuntimeData />

The daemon home directory is `~/.monad` on macOS, the XDG directories on Linux,
and `%APPDATA%/monad` on Windows. `MONAD_HOME` overrides these locations. See
[runtime.md](/internals/infra/runtime) for the complete transport and security model.

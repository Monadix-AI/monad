# Sessions, agents, and approvals

How to work with monad's core objects day to day: create and continue sessions,
branch and rewind them, answer approval requests, and choose which agent handles a
conversation. For one-paragraph definitions of each concept, see
[concepts.md](../concepts.md); this guide is the operational view.

## What a session is

A session is one persistent conversation thread between you and an agent. It lives
in the daemon, not in any client: the transcript, tool events, and resume state
survive daemon restarts, and every client — web UI, CLI, TUI, editor, IM channel —
sees the same session. Closing a browser tab or terminal never loses a
conversation.

Each session records an immutable origin (which surface created it and which
transports may write into or fork it) — see
[session-origin.md](../internals/session-origin.md) for the model.

## Creating and continuing a session

**Web.** Run `monad` (or `monad up`) to start the daemon and open the web UI. The
home screen starts a new session from the composer; you can pick which agent
handles it before sending the first message. Existing sessions are listed and
resume where they left off.

**CLI.** `monad chat` is the conversational entry point:

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

Inside any conversation, typing `/` opens the command and skill menu: `/new`
starts a fresh session, `/sessions` lists them, `/switch` changes the active one,
and `/handoff` summarizes the current conversation and continues it in a new
session. The same commands work from every surface, including IM channels. See
[skills.md](skills.md) for the skill side of the `/` menu.

## Branching and restoring

Sessions form a tree. Use these when you want to explore without losing the
original thread:

- **Branch** forks a child session from a parent — from the tip, or from a
  specific message. The parent is untouched; the child starts with the history up
  to the branch point. Use it to try a different approach, ask a side question
  with full context, or compare two directions.
- **Restore** rewinds a session in place to an earlier message checkpoint,
  discarding everything after it. Use it when a conversation went off the rails
  and you want to redo from a known-good point. Unlike branch, this rewrites the
  session itself, so the web UI asks you to confirm.

In the web UI, hover a settled message to find the branch and restore actions;
the session header shows the lineage (parent and branches) once a session has
either. From the CLI:

```sh
monad session branch <sessionId> [title] [atMessageId]   # fork a child session
monad session restore <sessionId> <toMessageId>          # rewind to a checkpoint
monad session tree <sessionId>                           # show ancestors and descendants
```

Whether a transport may fork a given session is part of the session's origin
policy (`branchableBy`) — see
[session-origin.md](../internals/session-origin.md).

## Approvals

When the agent wants to run a high-risk tool — shell commands, file writes
outside its sandbox, self-authored skills, and similar — the call pauses at the
approval gate until a human answers. The turn blocks; nothing executes while the
request is pending.

In the web UI the request appears as an approval card in the transcript, naming
the tool and its input. You can:

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
monad approvals list                            # show remembered allow/deny rules
monad approvals revoke <id>                     # remove one rule
monad approvals clear [--scope <s>] [--agent <id>]
```

Native CLI agents run their own approval
prompts; monad only decides whether those run unattended or are relayed to you —
see [native-cli-approvals.md](native-cli-approvals.md).

## Agents

An agent is the configured persona a session runs with: its name, system prompt,
model profile, skill set, tool exposure, sandbox mode, and limits. One daemon can
define many agents; each session binds to exactly one at creation. If you don't
pick one, the daemon uses the default agent (`agent.defaultAgentId` in
`config.json`).

Agents are defined under `agent.agents` in `config.json` and edited in the
Studio section of the web UI. Per agent you can set, among other things:

- `modelAlias` and per-role model overrides — e.g. a cheaper model for memory work.
- `skills` — per-agent skill auto-load overrides (see [skills.md](skills.md)).
- `atoms` — which tools and capabilities the agent may use.
- `sandbox`, `maxTurns`, `maxBudgetUsd` — containment and spending limits.

To use a specific agent, select it when creating the session (the agent picker in
the web home screen, or the `agentId` field on the create-session API). A
session's agent is fixed at creation; to move a conversation to a different
setup, use `/handoff` or branch into a new session created with the other agent.

## Watching sessions across clients

Because sessions live in the daemon, any client can observe a session another
client is driving. A conversation started from Telegram shows up in the web UI's
session list, and its replies stream there live; `monad session watch <id>` tails
the same events in a terminal. Whether another client may also *write* into that
session is governed by the session's origin policy — by default each surface's
sessions accept messages only from their own transport class
([session-origin.md](../internals/session-origin.md)).

## Where your data lives

Everything is local. Sessions, config, credentials, skills, and memory live under
the daemon's home directory — `~/.monad` on macOS, XDG directories on Linux,
`%APPDATA%/monad` on Windows (`MONAD_HOME` overrides all of these). The daemon
listens on loopback only by default; no session data leaves your machine except
the model calls you configure. See [runtime.md](../internals/runtime.md) for the
transport and security model.

---
title: "Use Third-Party Agents"
sidebarTitle: "Third-Party Agents"
description: "Run provider-native agents inside durable Monad sessions with scoped supervision."
keywords: ["third-party agent", "external agent runtime", "Codex", "Claude Code", "provider-native agent"]
---
Third-party agents are how provider-native agents join Monad Mesh. They run inside a Monad
session as team members: Monad Mesh supervises the runtime, scopes it to one conversation,
and presents its activity as a continuous timeline. The provider still owns model behavior,
authentication, provider session identity, and provider-owned approvals.

A mesh can be made entirely of third-party agents. Monad Agent Runtime is the first-party
alternative for a member, not a prerequisite for one.

For the HTTP, stream, and cursor contracts, see
[third-party agent observation](/internals/agent-team-runtime/mesh-observation). To add a provider, see
[Author a third-party agent adapter](/internals/agent-team-runtime/mesh-adapter-authoring).
## Supported providers

Monad ships adapters for eight providers:

| Provider ID | Product |
| --- | --- |
| `codex` | Codex |
| `claude-code` | Claude Code |
| `antigravity` | Antigravity |
| `gemini` | Gemini CLI |
| `qwen` | Qwen Code |
| `openclaw` | OpenClaw |
| `hermes` | Hermes |
| `monad` | Monad (another Monad runtime driven as a mesh member) |

Third-party atom packs may register additional provider IDs.

## Check what is configured

The provider's own CLI has to be installed on this machine. Start from the roster:

```bash
monad mesh agents          # configured third-party agents, with their provider and state
monad mesh auth codex      # the provider's sign-in state
```

**Sign-in is not brokered.** A third-party agent is a separate product with its own credentials,
so Monad never proxies its login: sign in with that provider's CLI (`codex login`,
`claude`, …) and Monad picks the session up. `monad mesh auth` only reports the state, and
a provider that exposes no probe reports `unknown`.

In the browser, **Studio → Mesh agents** shows the same roster and is the only surface
that can run an interactive provider login inside an embedded terminal.

## Run one in a session

A third-party agent always runs against a Monad session — the transcript it reports into. A
project-bound conversation still has its own `ses_…` id; a project id is not accepted.

```bash
ID=$(monad session new "codex on this repo" --json | jq -r .id)

monad mesh start codex --session "$ID" --cwd .   # spawn the runtime
monad mesh list                                  # live runtimes, daemon-wide
monad mesh show mesh_123456789012                # lifecycle, activity, connection
```

`mesh start` refuses to spawn a runtime that would only sit at a login prompt, and rejects
a `--cwd` outside the session's configured project root.

## Watch and drive it

```bash
monad mesh watch  mesh_123456789012              # follow the neutral projection
monad mesh watch  mesh_123456789012 --raw        # verbatim provider frames (diagnostic)
monad mesh input  mesh_123456789012 "add tests for the parser"
monad mesh steer  mesh_123456789012 "stop, do the migration first"
monad mesh interrupt mesh_123456789012
monad mesh stop   mesh_123456789012
monad mesh usage  [mesh_123456789012]            # provider overview or one runtime's tokens
```

`watch` prints one line per observation event and resumes from the last cursor after a
dropped connection; `--json` emits NDJSON. `--raw` is a privileged diagnostic surface: it
can contain prompts, tool arguments, file content, environment details, or credentials.

Approvals raised by the provider are answered the same way:

```bash
monad mesh approve mesh_123456789012 <requestId> [--reason "…"]
monad mesh deny    mesh_123456789012 <requestId> [--reason "…"]
```

Whether a runtime accepts steering, interrupts, or approval resolution depends on its
adapter — read the session's effective capabilities rather than assuming, and see
[native CLI approvals](/usage/native-cli-approvals) for the autopilot switch.

The web UI renders the same runtime as a live card in the transcript with the same
controls; the CLI is the scriptable path and the only one usable headlessly.

## Use reported capabilities

Agent and preset responses may include this capability object:

```ts
type MeshAgentCapabilities = {
  auth: 'pty' | 'status-probe' | 'none';
  events: 'paged' | 'provider-owned' | 'none';
  resume: 'pty' | 'structured' | 'none';
  approval: 'provider-owned';
  autopilot?: boolean;
  fastMode?: boolean;
  settingsImport?: boolean;
  approvalProxy?: boolean;
};
```

Use these fields to decide which setup and history controls to show. Session controls
come from the effective runtime capabilities returned with each MeshSession. Do not
infer capabilities from the provider name or expose provider process topology.

## Build against the API

Every verb above is a thin wrapper over the daemon's Mesh API — `POST /v1/mesh/sessions`
to start a runtime, `/stream/convenience` and `/stream/raw` for the two observation
planes, `/events/convenience` for history. A client written against it must resume with
`Last-Event-ID`, treat the `ready` frame's `eventsBefore` cursor as the history anchor,
and replace local state when the server sends a replacement snapshot instead of a patch.

The request and response shapes, cursor rules, and epoch semantics are specified in
[third-party agent observation](/internals/agent-team-runtime/mesh-observation). Observation never
writes chat: only Message Ingress creates durable messages.

## Common failures

| Symptom | Meaning | Next step |
| --- | --- | --- |
| The agent is missing from `monad mesh agents` | It is not configured | Configure it in Studio → Mesh agents, or import its settings with `monad import settings` |
| The preset reports `installed: false` | The provider executable was not found | Install the provider CLI, then re-check |
| `monad mesh auth <agent>` reports `unauthenticated` | Provider credentials are missing or expired | Sign in with that provider's own CLI |
| `monad mesh start` rejects `--cwd` | The path is outside the session's configured project root | Choose a path inside that root |
| A control returns unsupported capability | The active provider runtime cannot perform it | Use the session's effective runtime capabilities |
| Convenience history is empty | The provider has no readable event source or projection | Check raw observation and adapter support |
| Stream replays from the epoch start | The resume cursor is malformed, foreign, or stale | Replace local live state with the new `ready` anchor |
| Raw page reports `settled` coverage | Provider history omits transient transport deltas | Treat it as settled history, not byte-complete live capture |


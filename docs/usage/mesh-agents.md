# Use MeshAgents

MeshAgents run provider-native coding agents inside a Monad session. Monad supervises
the runtime, scopes it to one conversation, and presents its activity as a continuous
timeline. The provider still owns model behavior, authentication, provider session
identity, and provider-owned approvals.

For the HTTP, stream, and cursor contracts, see
[MeshAgent observation](../internals/mesh-observation.md). To add a provider, see
[Author a MeshAgent adapter](../internals/mesh-adapter-authoring.md).

## Supported providers

Monad ships adapters for six providers:

| Provider ID | Product |
| --- | --- |
| `claude-code` | Claude Code |
| `codex` | Codex |
| `gemini` | Gemini CLI |
| `qwen` | Qwen Code |
| `openclaw` | OpenClaw |
| `hermes` | Hermes Agent |

Third-party atom packs may register additional provider IDs.

## Enable and authenticate an agent

Start by inspecting the installed presets and configured agents:

```http
GET /v1/mesh/agents/presets
GET /v1/mesh/agents
```

Enable a configured agent, then check its provider-owned authentication state:

```http
POST /v1/mesh/agents/codex/enable
GET  /v1/mesh/agents/codex/auth/status
```

If the status is `unauthenticated`, start an interactive login:

```http
POST /v1/mesh/agents/codex/auth/start
```

The response contains an auth session and a scoped `controlToken`. Use that token for
the auth-session event, input, resize, heartbeat, and stop endpoints under
`/v1/mesh/auth-sessions/:id`. Do not attach a `transcriptTargetId` to an auth session;
authentication happens before a MeshSession exists.

## Use reported capabilities

Agent and preset responses may include this capability object:

```ts
type MeshAgentCapabilities = {
  auth: 'pty' | 'status-probe' | 'none';
  events: 'paged' | 'provider-owned' | 'none';
  resume: 'pty' | 'structured' | 'none';
  approval: 'provider-owned';
  settingsImport?: boolean;
  approvalProxy?: boolean;
};
```

Use these fields to decide which setup and history controls to show. Session controls
come from the effective runtime capabilities returned with each MeshSession. Do not
infer capabilities from the provider name or expose provider process topology.

## Start and observe a MeshSession

`transcriptTargetId` is a Monad session ID. A project-bound conversation still has its
own `ses_...` ID; a project ID is not accepted by the Mesh session API.

```http
POST /v1/mesh/sessions
Content-Type: application/json

{
  "transcriptTargetId": "ses_123456789012",
  "agentName": "codex",
  "workingPath": "/workspace/example"
}
```

A successful response identifies the runtime:

```json
{
  "session": {
    "id": "mesh_123456789012",
    "sessionId": "ses_123456789012",
    "agentName": "codex",
    "provider": "codex",
    "workingPath": "/workspace/example",
    "approvalOwnership": "provider-owned",
    "runtimeRole": "interactive",
    "lifecycle": { "state": "active" },
    "activity": { "state": "idle", "pid": null, "queuedTurnCount": 0 },
    "connection": { "state": "inactive" },
    "capabilities": {
      "input": true,
      "steer": false,
      "interrupt": false,
      "approvalResolution": false,
      "providerSessionContinuation": true,
      "runtimeRestoration": true,
      "sessionReopen": true
    },
    "startedAt": "2026-07-19T00:00:00.000Z",
    "updatedAt": "2026-07-19T00:00:00.000Z"
  }
}
```

Normal product UI uses the convenience stream. Raw observation is a privileged
diagnostic surface that may contain prompts, tool arguments, file content, environment
details, or credentials.

```http
GET /v1/mesh/sessions/mesh_123456789012/stream/convenience?transcriptTargetId=ses_123456789012
Accept: text/event-stream
```

The stream starts with a `ready` frame and then sends atomic patches:

```text
id: live:oep_123:0
event: mesh.convenience_observation
data: {"kind":"ready","observationEpoch":"oep_123","cursor":"live:oep_123:0","eventsBefore":"provider:"}

id: live:oep_123:1
event: mesh.convenience_observation
data: {"kind":"patch","cursor":"live:oep_123:1","operations":[{"op":"upsert","event":{"id":"evt_123","kind":"assistant-message","streaming":false,"text":"Inspecting the repository","provenance":{"contractEvents":[{"type":"agent_message"}]}}}]}
```

Pass the last SSE ID back through `Last-Event-ID` when reconnecting. Earlier activity is
loaded through `/events/convenience` using the `eventsBefore` cursor from `ready`.

## Common failures

| Symptom | Meaning | Next step |
| --- | --- | --- |
| Agent is absent from `/v1/mesh/agents` | It is not configured | Inspect presets, then configure or import it |
| Preset reports `installed: false` | Provider executable was not found | Install the provider CLI and refresh presets |
| Auth state is `unauthenticated` | Provider credentials are missing or expired | Start the provider-owned auth flow |
| Start rejects `workingPath` | The path is outside the session's configured project root | Choose a path inside that root |
| A control returns unsupported capability | The active provider runtime cannot perform it | Use the session's effective runtime capabilities |
| Convenience history is empty | The provider has no readable event source or projection | Check raw observation and adapter support |
| Stream replays from the epoch start | The resume cursor is malformed, foreign, or stale | Replace local live state with the new `ready` anchor |
| Raw page reports `settled` coverage | Provider history omits transient transport deltas | Treat it as settled history, not byte-complete live capture |

Observation never writes chat directly. Only Message Ingress creates durable chat
messages.

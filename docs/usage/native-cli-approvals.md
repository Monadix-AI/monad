---
title: "Native CLI Agent Approvals"
description: "Understand how Monad relays provider-native CLI approvals and chooses safe unattended behavior for third-party agents."
sidebarTitle: "Native CLI Approvals"
---
Native CLI providers decide when a tool call requires approval. Monad does not apply
its own approval policy to a third-party agent; it can only relay a provider-owned request when
the active session driver exposes an approval-resolution control.

## Autopilot

`allowAutopilot` is configured on the agent and may be overridden per Workplace member.
For managed agents, Monad resolves the effective value before creating the provider
runtime:

- When Autopilot is on, the adapter adds the provider's verified unattended-mode
  arguments where supported. Any approval request that still leaks through is denied.
- When Autopilot is off, Monad delegates provider approvals only if the created session
  reports `capabilities.approvalResolution: true`.
- If the runtime cannot resolve approvals, the settings UI keeps Autopilot locked and
  explains why. The daemon never guesses support from the provider name or process
  topology.

The adapter declares the effective control on its session-scoped driver:

```ts
type ProviderDriverControls = {
  approvalResolution:
    | false
    | { resolve(request: MeshAgentApprovalResolutionRequest): Promise<void> };
  steer: false | { send(input: MeshAgentTurnInput): Promise<void> };
  interrupt: false | { run(): Promise<void> };
};
```

Whether a provider keeps a writable approval channel is a property of its session
driver, not of the product name:

| Provider | Approval resolution | Driver |
| --- | --- | --- |
| `codex` | Yes | Codex app-server |
| `gemini` | Yes | Gemini ACP session |
| `qwen` | Yes | Resident structured stream |
| `openclaw` | Yes | Gateway app-server |
| `hermes` | Yes | Gateway app-server |
| `monad` | Yes | Monad app-server |
| `claude-code` | No | Per-turn structured stream, no writable request channel |
| `antigravity` | No | Session-event JSONL stream, read-only |

A provider with no approval resolution can still run: Monad keeps Autopilot locked for
it and denies any request that leaks through, rather than silently letting the call
proceed. Always read the session's effective `capabilities.approvalResolution`; do not
infer it from this table alone, since an adapter can change driver between releases.

## Delegated flow

1. The managed-runtime launcher creates the provider driver and reads its effective
   capabilities.
2. The provider emits `approval_requested`; Monad records it in the session's pending
   approval map and publishes `mesh.approval_requested`.
3. The project UI sends the human's allow or deny decision to the Mesh approval endpoint.
4. The daemon calls the active driver's `approvalResolution.resolve` method and publishes
   `mesh.approval_resolved`.

Provider protocol request IDs, control envelopes, and writable channel details stay
inside the adapter. PTY prompt parsing is never used for Mesh session approvals.

# Native CLI agent approvals

Native CLI providers decide when a tool call requires approval. Monad does not apply
its own approval policy to a MeshAgent; it can only relay a provider-owned request when
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

Codex exec, Claude Code print mode, and Gemini CLI currently use resumable per-turn
structured streams and do not keep a writable approval request channel, so their
approval-resolution control is false. Qwen's resident structured stream supports the
two-way control messages needed to resolve provider approvals. OpenClaw and Hermes do
not currently expose a qualifying Mesh session runtime and are rejected at session
start; their authentication and configuration discovery remain available.

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

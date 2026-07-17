# Codex Root Thread Identity Design

## Problem

Monad drives a managed Codex app-server session by storing one canonical `providerSessionRef` and sending each fanout delivery to that thread with `turn/start`. Codex multi-agent v2 also emits `thread/status/changed` notifications for child agents spawned by the managed root agent.

The Codex adapter currently converts every status notification into a `session_ref` event. The external-agent host treats every `session_ref` as authoritative and overwrites the live and persisted `providerSessionRef`. When a child agent reports status, its thread ID can therefore replace the managed root thread ID. The next project delivery reaches Monad and the Codex provider, but app-server rejects the direct turn with `direct app-server input is not allowed for multi-agent v2 sub-agents`.

## Selected Semantics

The managed app-server thread identity is established only by the response to Monad's own `thread/start` or `thread/resume` request.

- A matching `thread/status/changed` notification may preserve the existing identity and status metadata.
- A status notification for any other thread is child-agent activity and must not emit a `session_ref` event.
- Child activity remains available through the normal observation stream; this change only prevents it from mutating the delivery target.
- Other providers and non-app-server launch modes are unchanged.

## Architecture

Make Codex server-notification parsing aware of the current `ExternalAgentRuntimeHandle`. For `thread/status/changed`, emit `session_ref` only when `params.threadId` equals `handle.providerSessionRef`.

The response parser remains the sole identity bootstrap path: successful `thread/start` and `thread/resume` responses emit the canonical `session_ref`. A notification received before that response cannot establish identity. Stateless parser calls without a runtime handle retain their existing shape-oriented behavior for compatibility with offline parsing and focused adapter tests.

No provider-error string matching or automatic retry is added. Preventing identity corruption fixes the source of the rejection and avoids losing the first delivery before recovery.

## Data Flow

1. Monad starts or resumes the managed Codex root thread.
2. The corresponding JSON-RPC response establishes `handle.providerSessionRef`.
3. The root agent may spawn multi-agent v2 children.
4. Child `thread/status/changed` notifications are parsed as non-authoritative and cannot change the root reference.
5. The next fanout delivery continues to send `turn/start` to the root thread.

## Error Handling

- A mismatched status thread ID is ignored only for session identity; it does not stop the runtime or emit a provider error.
- A failed root `thread/start` or `thread/resume` continues through the existing `connection_required` path.
- Genuine turn errors continue through the existing provider-error projection.
- The host retains its current persistence behavior because it receives no false `session_ref` event.

## Verification

TDD will add adapter regression coverage proving:

- a child status notification produces no `session_ref` when the runtime handle already identifies a different root thread;
- a matching root status notification preserves the existing `session_ref` contract;
- the canonical thread start/resume response still establishes the root identity.

After focused tests, run lint, typecheck, and the repository test gate. Deploy locally, start the GPT project member through the normal managed-member path, and verify a project fanout turn is accepted after the agent has spawned a child.

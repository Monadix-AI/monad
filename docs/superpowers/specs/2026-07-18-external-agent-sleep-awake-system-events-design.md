# External Agent Sleep and Awake System Events

## Goal

Render external-agent idle lifecycle notices with the same member identity treatment as existing project-member system events. The UI must show the configured display name and avatar instead of exposing a `pmem_*` identifier, and the notice body must use concise sleep/awake language.

## User Experience

The existing system-event row remains the visual surface. Its actor slot renders the member through the same `AgentInstanceAvatar` and `AgentIdentity` composition used by the project-member join event, including the configured avatar, product icon, and tag.

The body contains only the action, because the actor slot already contains the member name:

- English suspend: `fell asleep.`
- English resume: `woke up.`
- Chinese suspend: `睡着了。`
- Chinese resume: `醒来了。`

The lifecycle events do not introduce a new card type or lifecycle-specific avatar style.

## Contract and Data Flow

External-agent lifecycle notices use a protocol-owned discriminated system-event contract:

```ts
type ExternalAgentSystemEvent =
  | {
      agentId: string;
      agentName: string;
      type: 'idle_suspended';
      payload: {
        externalAgentSessionId: string;
        idleTimeoutMs: number;
      };
    }
  | {
      agentId: string;
      agentName: string;
      type: 'idle_resumed';
      payload: {
        externalAgentSessionId: string;
      };
    };
```

The schema is a strict `z.discriminatedUnion('type', ...)`, so each event type accepts only its matching payload. The same variant schemas are reused by the daemon event table and by `UISystemItem.event`; consumers do not redeclare the shapes.

`agentId` is the stable `pmem_*` runtime identity. `agentName` is the configured display name and falls back to `agentId` only when no display name is configured. The host emits this shape at the lifecycle boundary, and the daemon projection carries it unchanged into the system item while localizing only the action text.

The chat-room projection resolves `event.agentId` through the existing project-member metadata maps. It uses the same identity inputs as the member-join system event:

- member display name;
- configured avatar seed and avatar style;
- provider product icon;
- provider tag.

The projected message sets `agentChip`, allowing the existing `SystemMessageRow` actor slot to render the identity without renderer changes. The message body uses the localized action-only text from the system item.

Display-name resolution prefers the external-agent display-name map, then member metadata, then `event.agentName`, then `event.agentId`. If current member metadata is unavailable, projection falls back to the event identity, existing icon inference, and a deterministic generated avatar. The notice remains visible, but configured metadata always wins when present.

## Compatibility

The `event` field is optional, so persisted and live system items without it continue to parse and render as today. Identity is no longer inferred from the lifecycle system-item ID for new sleep/awake events. Existing lifecycle items that lack an event may retain the legacy ID-prefix fallback during migration.

## Testing

Tests cover:

- strict parsing of the exact suspend/resume union variants and rejection of mismatched payloads;
- the exact `UISystemItem` contract emitted for suspend and resume, including the structured event;
- configured-name and missing-name host emission, including `agentName === agentId` fallback;
- English and Chinese action-only copy;
- projection from a `pmem_*` event identity to the configured project-member display name, avatar, product icon, and tag;
- `agentChip` output matching the member-join system-event identity shape;
- fallback behavior when project-member metadata is unavailable;
- continued rendering of legacy lifecycle system items without a structured event.

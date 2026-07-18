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

`UISystemItem` gains an optional structured actor reference. External-agent idle suspend and resume projections populate it with the external-agent member identifier already present in the source event. Existing system items may omit the actor and remain backward compatible.

The chat-room projection resolves the actor reference through the existing project-member metadata maps. It uses the same identity inputs as the member-join system event:

- member display name;
- configured avatar seed and avatar style;
- provider product icon;
- provider tag.

The projected message sets `agentChip`, allowing the existing `SystemMessageRow` actor slot to render the identity without renderer changes. The message body uses the localized action-only text from the system item.

If current member metadata is unavailable, projection falls back to the actor identifier, existing icon inference, and a deterministic generated avatar. The notice remains visible, but configured metadata always wins when present.

## Compatibility

The actor field is optional, so persisted and live system items without it continue to parse and render as today. Identity is no longer inferred from the lifecycle system-item ID for new sleep/awake events. Existing lifecycle items that lack an actor may retain the legacy fallback during migration.

## Testing

Tests cover:

- the exact `UISystemItem` contract emitted for suspend and resume, including the structured actor;
- English and Chinese action-only copy;
- projection from a `pmem_*` actor to the configured project-member display name, avatar, product icon, and tag;
- `agentChip` output matching the member-join system-event identity shape;
- fallback behavior when project-member metadata is unavailable;
- continued parsing of system items without an actor.

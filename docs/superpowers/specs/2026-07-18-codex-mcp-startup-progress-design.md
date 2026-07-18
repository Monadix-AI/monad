# Codex MCP Startup Progress

## Goal

Stop presenting Codex app-server `mcpServer/startupStatus/updated` notifications as tool calls. Keep the cross-adapter observation contract provider-neutral, and let the chat experience render consecutive Codex startup notifications as one readable `Startup progress` card.

## Adapter Boundary

The Codex observation adapter recognizes `mcpServer/startupStatus/updated` but projects it as an unknown observation. The neutral event has `kind: "unknown"`, is non-streaming, and preserves the complete raw JSON-RPC notification. It is not a tool call, tool result, system lifecycle event, or new cross-provider observation kind.

Other adapters and the neutral observation schema do not gain Codex-specific startup concepts.

## Chat Experience Projection

The chat observation timeline handles this event only when both conditions hold:

- the observed provider is Codex;
- the unknown event raw payload has `method: "mcpServer/startupStatus/updated"` and object-shaped params.

All consecutive matching events form one startup-progress entry. Any other observation ends the group.

Within a group, entries are keyed by `params.name`. Repeated updates for the same server replace its displayed state with the newest update while preserving the server's first-seen position. For example, `starting` followed by `ready` for `codex-security` produces one row with `ready`.

The card header is `Startup progress`. Each body row uses:

`MCP Server <name> <status>`

When the newest update carries an error, the row appends it:

`MCP Server <name> <status>: <error>`

Missing names fall back to `unknown`; missing statuses fall back to `updated`. Malformed lookalikes remain ordinary unknown cards.

## Raw Data and Ordering

The startup-progress card retains every raw notification in the consecutive group, including superseded statuses. Expanding raw JSON therefore shows the complete startup sequence rather than only the deduplicated display state.

The grouped card occupies the position of the first notification. Its timestamp uses the newest notification in the group, matching the final displayed progress state.

## Testing

Tests cover:

- Codex adapter output becoming neutral `unknown`, never `tool-call`;
- exact provider and method gating in the chat experience;
- consecutive notifications becoming one `Startup progress` card;
- latest-status deduplication per server with stable first-seen ordering;
- a non-startup observation splitting two startup groups;
- error, missing-field, and malformed-payload fallbacks;
- retention of all grouped raw notifications;
- existing tool-call pairing and unknown-card behavior remaining unchanged.

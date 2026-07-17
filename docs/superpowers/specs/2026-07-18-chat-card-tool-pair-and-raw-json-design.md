# Chat Card Tool Pair and Raw JSON Design

## Goal

Render Claude Code SDK `tool_use` and `tool_result` content blocks as one tool card with input and output, and syntax-highlight the raw JSON shown by chat cards.

## Current behavior

Claude transcript records wrap content blocks in outer `assistant` and `user` messages. The observation adapter currently assigns the outer record type to every nested content block. A `tool_result` inside a `user` record is therefore classified as another tool call instead of a tool result, so the timeline renders two tool cards.

`RawInspectableCard` preserves the original JSONL text but renders it as an unhighlighted `pre` element even though the shared UI package already provides a theme-aware JSON `CodeBlock`.

## Design

### Provider normalization

The Claude Code observation adapter will assign nested tool content blocks their own provider event type:

- `tool_use` produces a tool observation with `providerEventType: "tool_use"`.
- `tool_result` produces a tool observation with `providerEventType: "tool_result"`.
- Text and reasoning blocks retain their existing outer-message semantics.

This keeps provider-specific decoding at the adapter boundary. The neutral observation classifier can then produce `tool-call` and `tool-result` without Claude-specific logic in the chat UI.

### Timeline pairing

The existing timeline behavior remains unchanged: an adjacent `tool-call` followed by a `tool-result` becomes one public tool card. The card presents the call input and result output together while retaining both raw source records for inspection.

This change does not add non-adjacent matching or reorder events. Matching by tool ID can be considered separately if provider streams later require it.

### Raw JSON highlighting

`RawInspectableCard` will render its exact joined JSONL string through the shared `CodeBlock` with JSON syntax highlighting. Opening, closing, accessibility labels, record order, and copied text remain unchanged.

## Error handling

Malformed or non-JSON raw records continue to display as their original text. Highlighting is presentational and must not parse, rewrite, or reject provider output.

## Tests

- Add an adapter regression using an assistant `tool_use` record followed by a user `tool_result` record. Assert the neutral events are a call and result and the timeline produces one paired card with the expected input and output.
- Update the raw inspection test to assert the expanded panel uses the JSON code renderer while preserving the exact ordered JSONL text.
- Run the focused atoms and UI tests, then the applicable lint and typecheck scopes.

## Out of scope

- Pairing non-adjacent tool events.
- Reformatting raw provider JSON.
- Changing tool card visual structure beyond combining the correctly classified call and result.

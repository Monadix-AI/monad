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

For shell tools named `Bash`, `bash`, or `shell`, the command card extracts the string `command` field from a structured input object. The input is highlighted as Bash rather than showing the entire input object as JSON. Non-JSON output is also highlighted as Bash; valid JSON output retains JSON formatting and highlighting.

### Raw JSON highlighting

Paired tool events will pass their two raw provider records as an ordered array instead of wrapping them in a synthetic `{ call, result }` object. `RawInspectableCard` will render each raw record in its own shared `CodeBlock`.

Each record is parsed independently for presentation. Valid JSON is pretty-printed with two-space indentation and highlighted as JSON. Invalid JSON remains unchanged. Opening, closing, accessibility labels, record order, and copied text remain unchanged; copying still returns the original unformatted JSONL rather than the formatted presentation.

### Claude thinking token progress

Claude Code `system` records with subtype `thinking_tokens` will project as reasoning progress instead of standalone system cards. The card text shows the latest cumulative estimate as `Thinking… · <estimated_tokens> tokens`.

Consecutive token progress records form one streaming run. The Claude adapter keeps the latest cumulative value for the card and retains every raw record in order for inspection. This latest-value merge is provider-owned and does not change append semantics for normal textual `thinking_delta` fragments.

The thinking label shimmers only while the agent stream is running and the streaming reasoning item is the latest timeline item. A later tool, assistant, system, or turn-end event settles the card. A stopped stream also settles it even when no later provider event arrived. Existing `prefers-reduced-motion` behavior continues to disable the animation.

### Provider diagnostic cards

Codex JSON log records shaped as `timestamp`, `level`, `fields`, and `target` will project to provider-neutral diagnostic metadata on a system observation. `ERROR` normalizes to error severity and `WARN` normalizes to warning severity. Other log levels retain the existing ordinary raw/system behavior.

Each diagnostic record renders as its own card. The card title is `fields.message`; an optional `fields.error` string renders as multiline detail; `target` and `timestamp` render as metadata. Error cards use destructive styling and warning cards use warning styling. The complete record remains available through the raw inspector.

Diagnostics are operational notices, not turn outcomes. They do not emit `turn-end`, change the agent session to failed, or stop later observations from streaming.

## Error handling

Malformed or non-JSON raw records continue to display as their original text. Highlighting is presentational and must not parse, rewrite, or reject provider output.

## Tests

- Add an adapter regression using an assistant `tool_use` record followed by a user `tool_result` record. Assert the neutral events are a call and result and the timeline produces one paired card with the expected input and output.
- Add a shell command projection regression that asserts structured Bash input becomes the command text and both input and non-JSON output use Bash highlighting.
- Update the raw inspection tests to assert multiple records render as separate, formatted JSON code blocks while preserving exact ordered JSONL copy text.
- Add Claude regressions for latest-value `thinking_tokens` aggregation, ordered raw retention, and reasoning projection.
- Add timeline rendering regressions that distinguish an active latest thinking item from a settled or superseded one.
- Add Codex adapter regressions for ERROR and WARN log normalization and for ignoring INFO as a diagnostic.
- Add shared diagnostic-card rendering regressions for severity styling, message, optional detail, target, and timestamp.
- Run the focused atoms and UI tests, then the applicable lint and typecheck scopes.

## Out of scope

- Pairing non-adjacent tool events.
- Reformatting the copied raw provider JSON.
- Changing tool card visual structure beyond combining the correctly classified call and result.
- Displaying `estimated_tokens_delta`; the card shows only the latest cumulative `estimated_tokens` value.
- Treating provider diagnostic logs as turn failures or merging separate log records.

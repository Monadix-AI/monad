# TUI Chat Runtime Stability Design

## Goal

Ensure TUI chat submissions render once, visibly indicate agent activity, show external-agent projection only when applicable, and retain stable column widths while text streams.

## Root Cause

Four independent UI symptoms share state and layout boundaries:

- The composer optimistically dispatches `addUserMessage(text)`, then `useStream` incorrectly commits the daemon's settled `user.message` echo through the assistant-only `commitMessage` reducer.
- `isStreaming` becomes true only after the first assistant token, leaving the request-to-first-token interval without activity feedback.
- `showProjection` checks only wide layout and an open chat, so normal chat sessions reserve an external-agent pane even when no external-agent session exists.
- The transcript uses content-driven flex growth beside a percentage-width projection pane, allowing streamed text's intrinsic width to change the column allocation.

## Design

### Stream reconciliation

Keep optimistic user insertion. Derive the settled cursor and new commits from settled assistant messages only, so ignored user echoes cannot shift the cursor or suppress a later assistant response. Place this calculation in a pure stream-model helper.

### Running indicator

Mark the local turn running as soon as a user message is submitted. Render a fixed-width Braille spinner while the turn is running, including before the first token. Existing assistant text continues streaming beside the fixed activity cell. Clear running state when an assistant message settles or a send request fails. Queue and steer continue to use the same busy state.

### Projection eligibility

Query external-agent sessions associated with the current transcript target. Show and focus the projection pane only when at least one associated external-agent session exists. Normal Monad chat and project chat remain transcript-only. Keep projection read-only and do not infer external-agent status from provider-specific output.

### Stable columns

Calculate integer chat widths from terminal columns, visible navigation width, borders, and projection eligibility. Apply explicit widths with shrinking disabled to transcript and projection panes. Spinner frames remain one terminal cell wide, so neither activity nor generated text changes the allocation.

## Error and Reconnect Behavior

The submitted user text remains visible when sending fails; the existing status path reports the request error and clears the running state. On reconnect or stream replay, user echoes remain ignored and settled assistant messages are committed according to the assistant-only cursor. Missing or failed external-agent list data degrades to no projection pane rather than an empty reserved column.

## Tests

- A mixed settled stream containing one user echo and one assistant response returns only the assistant response.
- A streaming assistant segment is excluded until it settles.
- The next cursor equals the number of settled assistant messages, not the total settled message count.
- A submitted user message enters running state before any assistant token; completion and explicit failure clear it.
- Spinner frames have a constant terminal-cell width.
- Projection eligibility is false for no associated external-agent sessions and true when one exists.
- Wide chat column widths remain constant for the same terminal/navigation/projection inputs regardless of message text.
- Existing TUI unit tests, typecheck for the TUI package, and formatting checks remain green.

## Non-goals

- Canonical ID reconciliation for optimistic user messages.
- Replacing the Redux transcript store.
- Changing daemon stream semantics or `@monad/client-rtk` normalization.
- Refactoring multi-segment assistant streaming beyond this duplicate-user regression.
- Making projection available for normal Monad chat sessions.

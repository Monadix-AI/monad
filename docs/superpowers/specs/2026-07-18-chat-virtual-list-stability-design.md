# Chat Virtual List Stability Design

## Scope

Fix three related chat experience defects:

1. The jump-to-latest button can stop above the true bottom.
2. A user reading older messages can lose their viewport position when new cards arrive or existing rows change height.
3. Claude `thinking_tokens` updates can concatenate cumulative labels and split one model generation across redundant cards.

The work stays within the shared virtual list, the chat message list integration, and external-agent observation projection. It does not change message persistence, ordering, pagination contracts, or agent loop semantics.

## Current Failure Modes

### False bottom

`VirtualList.scrollToBottom` scrolls the DOM scroller to its current `scrollHeight` three times over two animation frames. In a virtualized list, offscreen rows still use estimated heights. Smooth scrolling can therefore target a stale height while Virtuoso mounts and measures later rows, leaving the viewport above the final bottom.

### Viewport jumps while reading history

`firstItemIndex` preserves position only when older rows are prepended before the previous first item. It does not preserve an arbitrary visible message when a card is inserted before it or when a measured row changes height. The existing DOM layout anchor is temporary and activated only by pointer or keyboard interaction with marked controls, so incoming data has no durable viewport anchor.

### Thinking accumulation

There are two streaming merge implementations. The experience projection calls the provider's `mergeStreamingRun`, but `agent-adapters/event-source.ts`, which supplies the runtime event path, concatenates streaming text directly. Because `thinking_tokens` reports cumulative totals, this produces text such as `Thinking… · 1 tokensThinking… · 17 tokens`.

## Design

### Reliable jump to latest

An imperative bottom request becomes an explicit short-lived state rather than three DOM scroll attempts.

- Arm bottom following and clear any stale history anchor.
- Ask Virtuoso to scroll to `{ index: 'LAST', align: 'end' }` using the requested behavior.
- Prefer `smooth` for the visible movement.
- While the request is armed, reissue an automatic last-index correction when total list height changes.
- Complete the request only when Virtuoso reports `atBottom=true`.
- If smooth scrolling does not settle after the bounded correction window, finish with an automatic jump. Reliability wins over preserving the animation.

Normal pinned streaming continues to follow row growth. A genuine upward user scroll cancels both pinning and any active bottom request.

### Stable history viewport

When the list is not pinned, preserve the first actually visible message as a stable anchor:

- Record its item key and its top offset relative to the scroller after genuine user scrolling.
- Mark rendered items with their stable key so the same DOM row can be found after data changes.
- After item insertion, replacement, or row measurement, compare the anchor's current offset with its saved offset and compensate `scrollTop` by the difference.
- Repeat the correction on the next animation frame because virtualized row measurement can settle one frame later.
- Refresh the saved offset after correction.
- If the anchored message disappears, select the next visible row without forcing a jump.

Appending below the viewport produces no correction because the anchor offset does not change. Prepending history continues to use `firstItemIndex`; the stable anchor protects arbitrary insertions and height changes that `firstItemIndex` cannot represent.

### One thinking card per model generation

Streaming merge behavior remains provider-owned and both projection paths use it.

- Consecutive Claude `thinking_tokens` events form one streaming run.
- The run renders the latest event text only and retains all raw records for inspection.
- A non-thinking semantic event ends the run. Tool calls, tool results, assistant messages, and the next model-generation boundary therefore allow a new thinking card.
- The rule is not scoped to the whole agent turn: an agent loop may contain multiple model generations and therefore multiple thinking cards.
- Ordinary text and reasoning deltas keep append semantics.

The event-source merge must process a complete consecutive run before applying `mergeStreamingRun`; pairwise folding would produce nested raw arrays and make generation boundaries harder to reason about.

## Testing

Add regression coverage before implementation:

- A bottom-scroll coordinator remains active across height changes and completes only after the true bottom signal.
- An upward user scroll cancels an active bottom request.
- Anchor compensation preserves the same key and viewport offset when an item is inserted before it.
- Appending below the anchor does not move the viewport.
- Row-height growth above the anchor is compensated.
- Runtime `createProjectedEventSource` collapses many Claude cumulative token events to the latest value.
- A tool-call boundary separates two thinking runs into two cards.
- Existing append-style reasoning and message delta tests continue to pass.

Runtime verification should exercise a long chat in the web app: scroll into history while new messages arrive, then use the jump button and confirm the viewport reaches the final composer clearance without subsequent drift.

## Non-goals

- Replacing React Virtuoso.
- Disabling virtualization.
- Changing message sort order or history pagination.
- Merging all thinking cards in an agent turn.
- Changing observation card visual styling beyond correcting the displayed thinking value and grouping.

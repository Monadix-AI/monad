# Chat Experience Scroll Stability Design

## Goal

Make the Chat Experience transcript open at the true bottom without flashing the jump-to-latest control, keep the composer at or above its default height, and make continued downward scrolling at the bottom completely stationary.

## Current behavior and root causes

The three visible defects come from separate layers of the same layout:

1. The composer editor has an internal minimum height, but its outer `fieldset`, swap host, and overlay do not expose one shared minimum block-size contract. A constrained parent can therefore compress the default composer chrome even though the editor itself still requests 56 px.
2. `initialTopMostItemIndex` aligns the last message during the virtual list's mount. The footer contains a composer-height spacer whose measured height can change after mount. During that measurement window, Virtuoso can emit `atBottomStateChange(false)`, and Chat Experience immediately exposes the jump-to-latest button before the later re-pin reaches the true bottom.
3. Chat Experience opts into `VirtualList`'s custom `bounce` behavior. When the user wheels beyond the bottom edge, it translates the entire scroller by as much as 14 px and then springs it back. This is the reported page jump.

## External research

- React Virtuoso documents that [`initialTopMostItemIndex`](https://virtuoso.dev/react-virtuoso/virtuoso/initial-index/) only controls the mount position; later corrections must use `scrollToIndex`.
- The Virtuoso API documents [`atBottomStateChange`](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/) as an edge-state notification and `firstItemIndex` as the supported inverse-pagination mechanism. Initialization readiness must therefore be owned by the wrapper rather than inferred from the first false edge event.
- MDN documents that [`overscroll-behavior: contain`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overscroll-behavior) prevents scroll chaining but can retain native bounce, while `none` also suppresses the default overflow effect. A stationary chat boundary should use `none`.

## Design

### Composer minimum height

Define one shared default composer minimum-height token in `@monad/ui`. Apply it to the `UnifiedComposer` fieldset and its immediate host so the complete default surface cannot shrink below its rendered baseline. Keep the editor's existing content-growth behavior: attachments, questions, approvals, queued follow-ups, and multiline input may increase the height.

The Chat Experience overlay remains absolutely positioned. Its measured height continues to drive `--chat-room-composer-clearance`, so the transcript footer always reserves the actual composer footprint.

### Initial bottom settlement

Extend `VirtualList`'s bottom-following state with an explicit initial-settlement phase for non-empty `stickToBottom` lists that are not restoring saved state.

- Start internally pinned and suppress outward `false` bottom notifications while initial settlement is active.
- Keep correcting to the last item as item and footer measurements settle.
- Complete settlement only after the scroller reports the true bottom, then forward `true`.
- If the user deliberately scrolls upward during settlement, cancel settlement and forward the resulting non-bottom state so the component never fights user intent.
- Empty lists are immediately settled and remain at-bottom.

Chat Message List continues to initialize its local state as at-bottom. Because transient initialization events are no longer forwarded, the jump-to-latest button cannot flash or remain visible during page load.

### Stationary bottom boundary

Remove the `bounce` opt-in from Chat Experience and delete the generic custom transform implementation if no consumers remain. Change the chat scroller's vertical overscroll behavior from `contain` to `none`, preventing both ancestor scroll chaining and native edge bounce where supported.

### Pagination and live updates

Keep the existing synchronous `firstItemIndex` transition for prepending older messages. It preserves the visible anchor and is independent of initial bottom settlement.

After settlement:

- appended or growing content follows only while pinned;
- an upward user scroll unpins immediately;
- the jump-to-latest control appears only for a genuinely non-bottom viewport;
- clicking it starts an explicit bottom request and re-pins after dynamic measurements settle.

## Verification

Add regression coverage for:

1. initial false bottom events being suppressed until the first true bottom settlement;
2. deliberate upward input cancelling initial settlement;
3. composer outer markup carrying the shared minimum-height contract;
4. Chat Experience not enabling transform bounce;
5. runtime page load ending at the true bottom with no jump button;
6. repeated downward wheel input at the bottom producing no scroller transform or scroll-position change;
7. upward scrolling showing the jump button and clicking it returning to the true bottom;
8. older-message pagination preserving the visible message anchor.

Run the focused Bun unit and browser regression scopes first, then the repository lint, typecheck, test, and web build gates.

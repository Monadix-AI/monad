# Observation Boundary Scroll Design

## Goal

Make the observation panel's top and bottom buttons land on the true boundaries of the currently loaded virtual-list content.

## Behavior

- Top scrolls to the true top of the currently loaded content, including the list header boundary.
- Reaching the top continues to trigger the existing single-page history backfill.
- Prepended history preserves the current reading anchor. A later click scrolls to the new loaded top and may trigger the next page.
- One click must not recursively load all remaining history.
- Bottom scrolls to the true bottom after virtual row and footer measurements settle.
- Existing manual scrolling, follow-latest behavior, and history paging remain unchanged.

## Design

Extend `VirtualListHandle` with an explicit `scrollToTop` operation instead of approximating the top through the first row key. The operation targets the scroller's physical `scrollTop = 0`, clears bottom-follow state, and records the movement as programmatic.

Keep `scrollToBottom` as a physical-boundary operation, but verify its settlement against `scrollHeight - clientHeight` as dynamic row heights resolve. The observation panel calls these two boundary operations directly.

## Verification

- A unit regression proves top targets the physical zero boundary rather than the first item index.
- A unit regression proves bottom targets the current physical maximum and settles after height changes.
- Observation panel tests prove each button invokes its matching boundary operation.
- Existing virtual-list and observation tests remain green.

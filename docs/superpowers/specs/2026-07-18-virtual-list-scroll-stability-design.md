# Virtual list scroll stability

## Problem

Chat experience messages, external-agent observations, and session transcripts share
`@monad/ui`'s `VirtualList`. Two scroll-position owners currently overlap:

- `react-virtuoso` preserves position when `data` and `firstItemIndex` change together.
- `VirtualList` separately captures a rendered DOM row and writes `scrollTop` after
  item changes and height measurements.

The shared `useFirstItemIndex` hook updates its index from a layout effect, one render
after prepended data arrives. This breaks Virtuoso's atomic prepend contract and exposes
an intermediate frame. The additional DOM correction can then compensate the same
layout change a second time. Together these produce pagination flashes and small
oscillations when scrolling near the bottom.

## Behaviour

- Prepending older rows keeps the same previously visible row at the same viewport
  position without an intermediate jump.
- An upward user scroll immediately disables following, including inside the existing
  bottom threshold.
- Following resumes only after reaching the bottom or explicitly requesting
  `scrollToBottom`.
- Growing or appending content follows the bottom only while the list is pinned.
- User-triggered expansion and collapse may retain their targeted layout anchor.
- The behaviour is shared by chat experience, observation detail, and session chat.

## Design

Make `useFirstItemIndex` derive the next index synchronously during render from a small
per-list tracker. The returned `firstItemIndex` therefore changes in the same commit as
the new item array. The tracker locates the previous first key in the next array so
grouped or transformed rows remain supported; a wholesale dataset replacement resets
the base index.

Remove the generic keyed DOM viewport anchor and its post-commit `scrollTop` writes from
`VirtualList`. Virtuoso remains the sole owner of prepend and dynamic-size compensation.
Keep the existing pinned-bottom state machine and explicit layout anchor used for a
user's expand/collapse action, because those solve separate behaviours not represented
by `firstItemIndex`.

Do not add page-specific timers, loading overlays, fixed row heights, or CSS scroll
anchoring overrides. The three affected surfaces should inherit the same fix without
changing their loading UI or data contracts.

## Verification

- Add a state-transition regression test proving prepended items and the decremented
  absolute index are produced together, including transformed rows and dataset reset.
- Add a regression test proving manual viewport correction is not part of passive list
  updates while bottom-follow and explicit layout-anchor rules remain intact.
- Run the focused virtual-list tests, affected web/atom tests, lint and typecheck scopes.
- Exercise pagination and light bottom scrolling in the running app on chat experience,
  observation detail, and session chat when representative data is available.
- Record a before/after trace or frame-level measurement for the reproducible pagination
  interaction, in accordance with the repository performance guidelines.

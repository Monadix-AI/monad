# Observation History Autoload Design

## Problem

The provider retains the complete Codex session, but the observation rail initially exposes only the bounded live/history window. Older pages are prefetched behind a separate "Show history" gate, so reaching the top of the visible GPT observation can stop before the provider session begins even when `historyBefore` proves that older data exists.

## Design

External-agent observation history is one continuous timeline. When a neutral UI frame supplies `historyBefore`, the rail immediately requests the first older page and prepends it to the visible stream. Once that page is visible, the existing virtual-list `onStartReached` callback continues requesting `nextCursor` pages until the provider omits the cursor. The list keeps using stable event identities and `firstItemIndex`, preserving the visible anchor while pages are prepended.

Delivery observations retain their existing explicit-history behavior because they do not use the neutral external-agent UI stream.

## Failure Handling

A failed page request leaves already loaded events intact and ends the current load attempt. Switching agent sessions or observation epochs invalidates pending page results through the existing generation counter.

## Verification

- A pure presentation-state regression test proves external-agent pages are included without a manual request.
- Existing overlap/cursor tests prove paging skips duplicate-only pages and continues to the next cursor.
- The focused atoms unit suite and package typecheck must pass.

# Sidebar Drag-to-Collapse Design

## Goal

Let a user collapse the desktop session sidebar by continuing to drag its resize handle left after the sidebar reaches its 240 px minimum width. Crossing a 48 px overshoot threshold must preview the collapsed state immediately. Reversing the same drag before release must restore the expanded state immediately.

## Scope

This change applies only to pointer and primary-mouse resize gestures on the desktop session sidebar. It preserves the existing 240–420 px expanded width range, keyboard resize behavior, stored expanded width, explicit collapse/reveal controls, overlay auto-reveal behavior, and mobile layout.

## Interaction Contract

- The expanded sidebar continues to render no narrower than 240 px.
- Resize calculations retain the unclamped raw width derived from the gesture start width and pointer delta.
- A raw width at or below 192 px (`240 - 48`) enters the drag-collapse preview.
- A raw width above 192 px exits the preview during the same uninterrupted gesture.
- While preview-collapsed, the window-level move and end listeners remain active even though the sidebar and its handle are visually hidden.
- Reversing above the threshold restores the sidebar at 240 px first; further rightward movement resumes normal resizing.
- Releasing or cancelling while preview-collapsed commits the normal persisted collapsed state.
- Releasing or cancelling while expanded commits the normal persisted expanded state and stores the clamped final width.
- Keyboard Home, End, ArrowLeft, and ArrowRight retain their current behavior and never trigger drag-collapse.

## Architecture

Keep the existing shell layout and `useSidebarResize` hook. Do not introduce a panel-resize dependency for this feature.

Add a pure resize-state calculation near the hook. Given a raw width, it returns the visible expanded width and whether the drag is beyond the collapse threshold. This isolates threshold semantics from DOM events and makes boundary behavior cheap to unit test.

Extend `useSidebarResize` with a callback for changing the drag-collapse state. The hook owns gesture-local transition tracking so it calls the callback only when the threshold state changes, rather than on every animation frame. `SessionSidebar` connects the callback to the existing persisted `collapseSidebar` and `revealSidebar` actions. Window-level gesture listeners remain alive independently of whether React temporarily removes the visual resize handle.

The store remains the source of truth for `sidebarCollapsed`. Crossing the threshold updates the stored state only on the transition, not on every move frame. If the application closes mid-gesture, the persisted preference therefore matches the last visible state. Collapsing through drag never replaces the last stored expanded width with 240 px.

## Why No New Library

`react-resizable-panels` is the closest fit for min/max sizing, collapsible panels, persistence callbacks, and accessible separators. However, its collapse boundary is derived from the panel's collapsed and minimum sizes rather than accepting this feature's independent 48 px overshoot threshold. Adopting it would also require restructuring the app shell around a panel group while preserving the sidebar's absolute overlay auto-reveal mode.

`Allotment` provides split-pane snapping but does not expose the required independent snap threshold. `re-resizable` covers basic min/max resizing but not the collapse state machine or separator accessibility. Each option would retain custom gesture logic while expanding the change into a shell-layout migration.

## State and Data Flow

1. Resize begins and records the pointer coordinate and expanded width.
2. Each animation-frame-coalesced move calculates the raw width from the original gesture snapshot.
3. The pure calculation clamps the visible width to 240–420 px and marks raw widths at or below 192 px as collapse candidates.
4. Crossing the threshold invokes the existing collapse action without ending the gesture. The sidebar disappears, the main shell reclaims its space, and the collapsed preference is persisted once.
5. Crossing back invokes the existing reveal action, restores the sidebar at the clamped visible width, and persists the expanded preference once.
6. Gesture end flushes the latest pointer coordinate synchronously and applies any final threshold transition before removing listeners and document styles. It persists the final clamped width only when the gesture ends expanded.

## Error and Cleanup Behavior

- Pointer cancellation follows the same final-state rule as pointer release so the stored state matches the last pointer position.
- Component cleanup must remove any active listeners, cancel a queued animation frame, restore the document cursor and selection styles, and clear the resizing marker.
- Storage failures retain the existing best-effort local preference behavior and do not break resizing.
- Duplicate compatibility mouse events after pointer down remain suppressed by the existing guard.

## Testing

Unit-test the pure resize-state calculation at 191, 192, 193, 240, and 420+ px.

Add interaction coverage for:

- dragging below 192 px previews collapse before release;
- reversing above 192 px during the same drag restores the sidebar;
- releasing below the threshold persists collapsed state without overwriting the stored expanded width;
- reversing and releasing above the threshold persists expanded state and the final clamped width;
- keyboard resize remains bounded at 240–420 px and does not collapse.

Run the focused unit tests, the sidebar Playwright spec, web typecheck, and the repository's relevant lint/quality check for touched files.

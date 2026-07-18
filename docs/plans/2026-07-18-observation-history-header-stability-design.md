# Observation History Header Stability Design

## Goal

Keep the currently visible observation card at the same viewport position while older history loads and is prepended.

## Root cause

Observation rows already use synchronous `firstItemIndex` transitions, so prepended rows preserve the existing row anchor. The list header does not have a stable height: `Loading history…` adds an approximately 40 px header and a successful page removes it in the same update that prepends rows. Virtuoso preserves the item offset but cannot account for the separate header-height reduction, producing the visible jump.

## Design

### Explicit history lifecycle

`AgentTasksRail` will pass `historyActive={historyRequested}` to `ExternalAgentObservationPanel`. This distinguishes an active history browsing session from the initial state without deriving lifecycle from callback presence.

The lifecycle resets with the existing observation/history scope reset, so switching agent, delivery, external-agent session, or observation epoch cannot retain the status strip.

### Fixed-height status strip

The observation list header will render a fixed-height history status strip whenever either condition is true:

- the initial Show history action is available; or
- history browsing is active.

The strip height and padding stay identical across every state:

- before activation: `Show history` button;
- loading: `Loading history…`;
- active with another page: `Scroll up to load earlier`;
- active and exhausted: `Start of history`.

Only the strip content changes. The header DOM and block size remain mounted through loading success, subsequent pages, and exhaustion. Panels with no available or active history do not render the strip and do not gain blank space.

Detail and Summary observation modes consume the same status-strip node, so switching modes does not change the history-state contract.

### Localization

Add the four history status strings to the English and Chinese web catalogs and render them through `workspaceExperienceT`.

## Verification

Add regression coverage that verifies:

1. the same fixed-height strip is present for show, loading, load-earlier, and exhausted states;
2. the correct localized state text is rendered;
3. panels without history render no strip;
4. a browser history-page success prepends rows while the previously visible observation card retains the same viewport top within one pixel;
5. existing `firstItemIndex` behavior continues to preserve grouped observation row keys.

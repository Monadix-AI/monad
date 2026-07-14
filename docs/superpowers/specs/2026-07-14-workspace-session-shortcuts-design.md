# Workspace session shortcuts

## Goal

Make workspace keyboard navigation match the visible sidebar instead of the project data model.

## Behavior

- `Mod+N` opens New chat through the existing new-chat action.
- `Mod+I` opens Inbox through the existing Inbox action.
- In Workspace, `Mod+1` through `Mod+9` open the first nine visible session rows in their on-screen order.
- Visible pinned sessions participate first when the Pinned section is visible.
- Visible project sessions and chat sessions share one sequence; project headers never receive a number.
- Sessions inside collapsed sections or collapsed projects do not participate.
- Sessions beyond a collapsed More preview do not participate because they are not rendered.
- Studio keeps its existing `Mod+1` through `Mod+9` section navigation.
- Matching shortcuts prevent the browser default action and reveal the sidebar consistently with existing numeric navigation.

## Design

Use the rendered workspace sidebar as the source of truth for numeric navigation. Mark session rows with a stable selector, collect eligible rows in DOM order, exclude rows beneath an inert collapsed ancestor, and activate the requested row. This keeps keyboard order aligned with the actual screen without lifting sidebar-only collapse and preview state into the routing layer.

When the primary modifier is held, assign shortcut badges to the same eligible rows so the displayed numbers and keyboard targets use one visibility rule. Remove the existing badges from project headers.

Keep shortcut matching and navigation orchestration in the existing sidebar shortcut hook. Pass the existing New chat and Inbox actions into that hook alongside the workspace session targeting behavior.

## Testing

- Unit-test `Mod+N` and `Mod+I`, including default prevention and action dispatch.
- Unit-test numeric selection across mixed session rows in DOM order.
- Verify rows under inert collapsed ancestors are excluded and missing numeric targets are ignored.
- Preserve tests for settings, Monad Agent, and Studio numeric shortcuts.
- Run the focused web tests, web typecheck, and repository formatting/lint checks appropriate to the touched files before committing.

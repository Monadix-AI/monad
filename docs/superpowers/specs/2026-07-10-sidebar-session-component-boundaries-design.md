# Sidebar and Session Component Boundaries

## Goal

Reduce prop drilling and oversized component interfaces in the workspace sidebar and session content area without changing UI, interaction, routing, animation, or rendered semantics.

## Current Problems

- `SessionRoute` receives roughly 37 top-level props and owns header, transcript, pending actions, inspector, composer, and skill-preview rendering.
- `useSessionRouteModel` derives its return type from `SessionRouteProps`, coupling the data model to one component's flattened interface.
- Sidebar data and actions travel from `ShellRouteProvider` through `SessionSidebar`, workspace sections, project lists, and tree rows.
- Translation, shortcut metadata, and session/project actions are repeatedly forwarded through components that do not use them.
- `SessionSidebarPanels` exposes more than 50 props and is not integrated, so it moves markup without establishing an ownership boundary.

## State Ownership

Use each state mechanism only for the lifetime and ownership it represents:

- RTK Query remains the sole owner of server data such as projects, sessions, and streamed UI items.
- Zustand stores own durable client UI state shared across component or route boundaries, including sidebar collapse, tree expansion where persistence is intended, preview counts, composer input, and inspector visibility.
- Route models own values derived from the active route and server data, including the active session, read-only state, transcript composition, and command-menu composition.
- Local component state owns transient interaction state that has no value outside the component, including pointer gestures and in-progress resize state.
- Local context distributes stable workspace-tree state, actions, and metadata to deeply nested tree rows. It must not duplicate RTK Query data or become a second global store.
- Props remain the default for data crossing one component boundary.

Navigation and mutation callbacks, refs, computed message arrays, and whole route models must not be copied into a global store merely to reduce prop counts.

## Session Architecture

Define an explicit `SessionRouteModel` independent of React component props. Split it into cohesive slices:

- `identity`: current session identity, title, origin, and read-only state.
- `transcript`: messages, virtual-list state, pagination callbacks, pending approvals, pending clarifications, and message actions.
- `composer`: command discovery, queue, model and composer settings, voice capabilities, input actions, submit, and stop.
- `inspector`: visibility, inspector items, and toggle action.

`SessionRoute` becomes a layout composer and delegates to focused components:

- `SessionHeader`
- `SessionTranscript`
- `SessionComposerRegion`
- `SessionInspectorRegion`

Each component receives only its corresponding slice. High-frequency transcript and stream data must stay out of a broad session context so updates do not invalidate unrelated regions. Existing specialized stores remain directly consumed through narrow selectors where the state is genuinely shared UI state.

## Sidebar Architecture

Split sidebar responsibilities without changing its DOM or animation behavior:

- `SessionSidebar` remains the frame and owns width, resize, auto-reveal, and pager gesture orchestration.
- A pager component composes workspace, studio, and settings surfaces from grouped surface configurations instead of a flat prop list.
- A footer component owns daemon-menu and theme controls from a dedicated daemon configuration.
- Workspace tree state and actions are exposed through a local `WorkspaceSidebarProvider` with a `state/actions/meta` interface.
- Project and session rows consume only the context fields they need, removing repeated CRUD, navigation, translation, and shortcut props from intermediate lists.

The workspace provider may expose existing project/session query results by reference, but it must not copy or synchronize those results into local or global state. Components outside the workspace tree must not depend on this context.

The unused `SessionSidebarPanels` implementation must either become the actual pager boundary or be removed. Two sidebar rendering paths must not remain.

## Compatibility Constraints

- Preserve existing visual output, class names, accessible names, roles, links, and keyboard behavior.
- Preserve sidebar resize, reveal, trackpad paging, collapse, expand, More/Less, rename, delete, pin, and create behavior.
- Preserve session transcript virtualization, scrolling, composer behavior, approvals, clarifications, command menu, voice input, inspector, and skill preview behavior.
- Do not introduce a second cache for server data.
- Do not broaden global Zustand stores with route callbacks, refs, or server entities.
- Keep context values memoized and actions referentially stable where practical.

## Testing

- Add unit tests for new model-shaping helpers and provider contracts where behavior can be tested without rendering the entire shell.
- Preserve and run existing sidebar interaction tests for navigation, CRUD actions, expansion, and More/Less behavior.
- Preserve and run session tests covering transcript composition, composer submission, pending actions, and session switching.
- Run TypeScript and Biome checks for all touched files.
- Use an end-to-end shell test to confirm that the refactor does not change visible sidebar or session behavior.

## Completion Criteria

- `SessionRoute` no longer has a large flat prop interface.
- Session content regions have focused, independently understandable contracts.
- Intermediate sidebar components no longer forward workspace actions they do not use.
- Sidebar mechanics, workspace-tree concerns, and daemon footer concerns have separate ownership boundaries.
- No server data is duplicated into Zustand or local context state.
- Existing behavior and interaction tests pass without updating expectations for intentional UI changes, because this refactor has none.

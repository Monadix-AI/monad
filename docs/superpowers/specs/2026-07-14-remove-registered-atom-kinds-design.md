# Remove Registered Atom Kinds Design

## Goal

Remove the Studio footer panel labeled “Registered atom kinds” and delete the read-only vertical API slice that exists only to populate it. Keep atom-pack discovery and rescanning unchanged.

## Scope

Remove:

- The footer panel in Studio atom settings.
- The `useListAtomKindsQuery` client hook and its endpoint definition/export.
- `GET /v1/settings/model/atom-kinds`.
- The daemon `listAtomKinds` handler used by that GET route.
- The dedicated `ListAtomKindsResponse` protocol type and schema.
- Tests that only assert the removed query.
- The English and Chinese `web.atoms.registeredKinds` translation entries.

Preserve:

- The Rescan button and its UI error reporting.
- `useDiscoverAtomKindsMutation`.
- `POST /v1/settings/model/atom-kinds/discover` and `discoverAtomKinds`.
- Provider registration, provider discovery, atom-pack manifests, and declared atom-kind enforcement.

## Architecture and Data Flow

The existing footer has a dedicated flow:

`AtomsSettings` → Client RTK `listAtomKinds` query → GET route → daemon `listAtomKinds` → provider registry types.

No other product feature consumes this read path. The implementation removes the complete flow instead of leaving an unused endpoint. The adjacent discovery flow is a separate mutation and remains intact.

## UI Behavior

Atom settings continues to show installation controls, rescan and refresh actions, conflicts, errors, and atom-pack cards. The footer containing registered-kind badges is absent. Removing it does not replace it with empty space or another summary.

## Compatibility

The removed GET route is an internal application endpoint with no remaining repository callers. This is an intentional API deletion, not a deprecation. The discovery POST route keeps its current path and response contract.

## Verification

- A source-level UI regression test asserts that atom settings no longer imports or renders the registered-kinds query/panel.
- Client endpoint tests no longer expose or call `listAtomKinds` while discovery tests remain.
- Daemon route/handler tests confirm the discovery POST behavior remains available.
- Protocol, client, web, and daemon type checks catch stale imports or exports.
- Targeted lint and repository searches confirm the removed symbols and translation keys have no references.

## Non-goals

- Redesigning the atom settings screen.
- Changing atom-pack discovery or registration semantics.
- Removing the `AtomKind` protocol model or manifest gating.
- Modifying unrelated in-progress workspace changes.

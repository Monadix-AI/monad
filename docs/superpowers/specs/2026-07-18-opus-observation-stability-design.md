# Opus observation stability design

## Problem

The Opus observation panel has three related correctness failures:

- Claude `thinking_tokens` runs reuse the same event id, so React and Virtuoso receive duplicate row keys. Scrolling can render the wrong row or an empty viewport, and local Raw JSON state can attach to the wrong card.
- Consecutive tool cards use the first entry as the group key. Prepending an older adjacent tool event changes that key and invalidates the virtual-list anchor.
- Agent presence searches the complete output snapshot for authentication phrases. Normal tool results containing text such as `sign in` therefore produce a false `Needs login` state.

## Design

Observation timeline identity will use `dedupeKey` when available and fall back to the provider event id. Tool-pair keys will be composed from those stable identities. Consecutive tool groups will use the last entry identity, which remains stable when older entries are prepended.

Authentication presence will inspect projected observation semantics rather than arbitrary snapshot text. Only system, unknown, or terminal events that carry an authentication signal can produce `needs-login`; user, assistant, and tool content cannot.

No list remount, virtualization removal, provider-specific UI branch, or persisted-data migration is required.

## Data flow

1. Provider events are projected to neutral observation items with `dedupeKey`, `kind`, `raw`, and provider ids.
2. The timeline derives stable entry keys from `dedupeKey ?? id`.
3. Raw JSON remains attached to the keyed entry, so card-local expansion state cannot cross between thinking runs.
4. History pages prepend rows without changing the identity of an existing tool group.
5. Presence parses the same neutral observation stream and considers only authentication-capable event kinds.

## Tests

- Multiple Claude thinking-token runs with the same provider event id produce distinct timeline row keys and retain their own raw records.
- Prepending an adjacent tool entry keeps the existing tool-group key stable.
- A tool result containing `sign in` does not produce `needs-login`.
- A structured authentication system event still produces `needs-login`.
- Existing observation history, virtual-list, and project-rail suites remain green.

## Acceptance criteria

- Scrolling to older Opus history and back does not blank the observation panel.
- Every thinking-token card opens the Raw JSON records belonging to that run.
- Opus is not marked `Needs login` because of ordinary tool, user, or assistant content.
- Genuine provider authentication failures still show `Needs login`.

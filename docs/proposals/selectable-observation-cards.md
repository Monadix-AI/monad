# Selectable observation cards

## Goal

Every projected observation card allows text selection across its header, timestamp, body, and expanded raw JSON.

## Design

`RawInspectableCard` is the shared outer boundary for projected observation cards. Its root carries `data-selectable="true"`, using the existing global selectable contract instead of adding card-specific CSS.

Interactive descendants remain buttons and preserve their existing click behavior. The change does not alter collapse state, raw JSON disclosure, copying, card layout, or ordinary chat messages.

## Verification

- A component test asserts the shared card root exposes `data-selectable="true"`.
- Existing disclosure, copy, observation-card, lint, typecheck, and unit tests continue to pass.

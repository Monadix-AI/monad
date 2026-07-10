# Draft Session Pending Feedback Design

## Goal

Homepage submission must provide the same immediate transcript feedback as sending from an existing session: the user message appears immediately, followed by a pending assistant label rendered with `Shimmer`.

## Behavior

- A draft in `creating` state produces a local user message and a pending assistant message.
- The pending label uses the selected agent's name. A draft without an explicit agent uses `Default Agent`.
- A failed draft retains the failed user message and does not render a pending assistant shimmer.
- Server-backed stream data replaces the draft feedback through the existing draft-to-real-session transition; the sidebar receives no separate loading treatment.

## Boundaries

- `draft-session-feedback.ts` builds deterministic draft view messages.
- `ChatMessage.tsx` accepts an optional assistant label and exposes pending state for testing.
- `use-session-route-model.ts` resolves the draft agent label and feeds the builder.
- The existing homepage E2E test verifies the pending label before session creation resolves.

# Shared Chat Cards and Raw JSON Design

## Goal

Move reusable chat card presentation into `@monad/ui` so Chat Session, Chat Experience, and External Session can select the cards they need without sharing behavior policy. Chat Experience and External Session cards backed by provider events must also expose their original provider or transport records as inline JSONL.

## Boundaries

- `@monad/ui` owns presentation, controlled disclosure primitives, and UI-only prop types.
- Consumers own projection from domain data, default state, expansion state, actions, data loading, and mutations.
- Shared components must not import `@monad/protocol`, clients, daemon modules, or Experience runtime modules.
- Components must not branch on session type. A consumer selects a component and passes the relevant presentation props.
- Cards with different semantics remain separate. In particular, Session directives, interactive Session approvals, read-only External Session approval observations, memory summaries, branch controls, observation timelines, and the agent task rail are not forced into a shared card contract.

## Shared presentation components

`@monad/ui` will provide focused card components rather than one discriminated-union renderer:

- `ChatCardShell`
- `MessageCard`
- `RichMessageCard`
- `ReasoningCard`
- `ToolCard`
- `CommandCard`
- `FileReadCard`
- `ClarificationCard`
- `AttachmentCard`
- `ErrorCard`
- `RawInspectableCard`

Each component accepts presentation props and optional slots for consumer-provided actions. Collapsible cards use controlled `expanded` and `onExpandedChange` props. Consumers decide the initial value and persistence policy.

## Raw JSON inspection

Raw inspection is an optional wrapper around any shared card. The wrapped card does not know that raw data exists.

The wrapper accepts:

- `open`: controlled disclosure state.
- `onOpenChange`: disclosure callback.
- `records`: original provider or transport records in arrival order.
- `onCopy`: optional consumer-provided copy callback.
- `children`: the visual card.

A raw record contains a stable UI key and the exact original record text. The UI layer must not parse, normalize, or reserialize it. Multiple records are joined with a newline and shown as JSONL in arrival order.

The trigger is hidden by default and becomes visible when the card is hovered or contains keyboard focus. It remains visible while the panel is open. On coarse-pointer or no-hover devices it is always visible. It has an accessible name and tooltip.

The panel expands inside the card below its normal content. It has a bounded height and its own scroll container. The raw `<pre>` is mounted only while open. Raw disclosure state is independent from the card's own detail disclosure state.

## Data flow

1. A provider adapter receives an original event or JSONL record.
2. The runtime retains the exact record text together with its stable event identity and arrival order.
3. Existing projection code maps normalized domain data into shared card presentation props.
4. The consuming surface associates all contributing raw records with the projected card.
5. If the association is non-empty, the consumer wraps the card in `RawInspectableCard` and owns its open state.
6. Chat Session can render the same card without the wrapper when provider raw records are unavailable or irrelevant.

One card may be backed by several records, including a tool call, streamed deltas, and a tool result. All associated records are shown; consumers must not silently reduce the set to the latest record.

## Consumer rules

### Chat Session

- Uses shared presentation cards where the visual semantics match.
- Owns Branch, Restore, retry, stop, approval, clarification, and disclosure behavior.
- Keeps Session-only directive, memory, compact, and branch projections local.
- Does not render a raw trigger without original provider or transport records.

### Chat Experience

- Projects Experience messages and activities into shared presentation props.
- Owns participant identity mapping, composer placement, stack order, default expansion, and agent actions.
- Uses `RawInspectableCard` for cards with associated provider records.

### External Session

- Uses shared read-only message, reasoning, command, file, tool, attachment, and error presentation where applicable.
- Keeps the observation timeline and agent task rail as Experience-specific containers.
- Does not reuse interactive Session approval or clarification cards. Provider-owned approval observations remain a separate read-only projection.
- Uses inline raw inspection for the original provider event sequence behind an observation card.

## Failure handling

- Missing raw records omit the trigger.
- Non-JSON text remains visible verbatim because the viewer renders original text rather than parsing it.
- Copy failures are handled by the consumer and must not close the panel.
- A raw record with a duplicate identity is deduplicated by the projection layer without changing arrival order.
- Card rendering must remain available if raw association fails.

## Performance

- Closed raw panels do not mount or syntax-highlight record contents.
- Raw content scrolls inside a bounded panel and does not expand the transcript indefinitely.
- Stable card and raw-record keys prevent streaming updates from resetting disclosure state.
- Projection code must preserve bounded runtime storage policies; the UI does not create a second unbounded copy of raw records.

## Accessibility

- The icon trigger has matching accessible name and tooltip text.
- Disclosure state is exposed with `aria-expanded` and the trigger targets the panel with `aria-controls`.
- The panel is keyboard reachable and preserves visible focus.
- Hover-only discovery has a focus and touch equivalent.

## Testing

- `@monad/ui` component tests cover controlled open/close behavior, hover/focus visibility, touch fallback, ordered JSONL rendering, copy callback, and missing-record behavior.
- Projection tests verify that multiple provider events associate with the correct card in arrival order.
- Chat Session tests verify shared cards still expose Session-specific action slots.
- Experience tests verify raw inspection is read-only and independent from the card detail disclosure.
- Existing transcript virtualization, outline, streaming, approval, clarification, and observation tests remain green.

## Out of scope

- Showing normalized `UIItem` JSON.
- A global Inspector mode or implicit Context-based raw lookup.
- Making all card semantics identical.
- Moving data fetching or provider parsing into `@monad/ui`.

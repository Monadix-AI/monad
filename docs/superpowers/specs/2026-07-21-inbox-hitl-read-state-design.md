# Inbox HITL and Read State Design

Date: 2026-07-21
Status: approved

## Summary

Inbox is the operator's durable attention queue. It aggregates three kinds of work:

- `mention`: a project message that mentions the human operator;
- `approval`: an unresolved tool or managed MeshAgent approval;
- `hitl`: an unresolved `clarify.requested` question that can be answered directly from Inbox.

Every item has two independent state axes:

- attention: `unread` until the item has been meaningfully visible to the operator, then `read`;
- action: `needs-response` while a human response is still required, then `completed`, `timed-out`, or `cancelled`.

Seeing an item does not complete it. Completing an item does not mark it read unless it was actually visible. The sidebar gives `needs-response` higher priority than ordinary unread activity.

The `clarify_ask` tool follows the current Codex request-user-input model: omitting `autoResolutionMs` means a human response is required with no automatic timeout; supplying it opts into bounded best-effort auto-resolution. Required HITL state is durable and must not be silently resolved by daemon restart, capacity pressure, a closed browser, or a dropped HTTP connection.

## Goals

- Add `hitl` as an Inbox item kind and allow the operator to answer it in Inbox.
- Let an agent explicitly choose between required human input and bounded best-effort input.
- Persist pending questions, their optional expiry, and their final disposition.
- Preserve required questions through browser disconnects and daemon restarts.
- Mark an Inbox item read only after meaningful on-screen visibility.
- Expose separate unread and needs-response summaries to the sidebar.
- Display a compact, accessible Need response badge in a narrow sidebar.
- Make response, timeout, cancellation, and read mutations idempotent and race-safe.
- Preserve the existing mention and approval Inbox behavior while migrating to a general Inbox API.

## Non-goals

- Turn Inbox into the managed MeshAgent delivery ledger.
- Treat every assistant message as an Inbox item.
- Add arbitrary agent-selected timeout durations outside the product's safe range.
- Mark all items read merely because Inbox was opened.
- Equate read, completed, cleared, archived, or removed.
- Add an infinite or continuously looping text marquee.
- Build assignment, snoozing, escalation policies, or multi-operator ownership in this change.
- Redesign approval policy scopes or the underlying approval engine.

## Research-informed decisions

Claude Code's `AskUserQuestion` callback may remain pending indefinitely, and its deferred-tool flow can persist the suspended request for later resume. Codex app-server exposes optional `autoResolutionMs`; the absence of that field represents a blocking elicitation. Durable workflow systems similarly model human approval as a persisted callback rather than a connection-bound request. Monad adopts those semantics while keeping its existing event-based architecture.

References:

- <https://code.claude.com/docs/en/agent-sdk/user-input>
- <https://code.claude.com/docs/en/hooks>
- <https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html>

For read state, `IntersectionObserver` supplies viewport intersection thresholds. `trackVisibility` can additionally exclude visually compromised targets but is not yet a Baseline feature, so it is an optional enhancement rather than a correctness dependency.

References:

- <https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API>
- <https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver/trackVisibility>

The Web implementation uses `react-intersection-observer@^10.1.0` rather than owning raw observer, scroll, or resize plumbing. Its `useOnInView` API exposes the native entry without forcing a React render for every visibility transition, reuses compatible observer instances, supports custom roots and Visibility v2 options, and ships test utilities for deterministic threshold tests.

Reference: <https://github.com/thebuilder/react-intersection-observer>

Slack distinguishes unread state from clearing or completing an activity and separately emphasizes mentions that require attention. Monad follows the same separation without copying Slack's conversation model.

References:

- <https://slack.com/help/articles/360043037853-Manage-your-Mark-as-Read-preference>
- <https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack/>

WCAG requires controls for non-essential moving or scrolling information that continues beyond five seconds. The Need response badge therefore uses static text, clipping, and a tooltip by default. Any overflow movement is finite, intent-triggered, stoppable, and disabled for reduced-motion users.

Reference: <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html>

## Domain model

### Inbox items

The protocol replaces the mention-specific public list shape with a general discriminated union:

```ts
type InboxItem = MentionInboxItem | ApprovalInboxItem | HitlInboxItem;

interface InboxItemContext {
  itemKey: string;
  projectId?: ProjectId;
  projectName?: string;
  sessionId: SessionId;
  sessionTitle?: string;
  createdAt: string;
  readAt?: string;
  actionState: 'informational' | 'needs-response' | 'completed' | 'timed-out' | 'cancelled';
  resolvedAt?: string;
}

interface HitlInboxItem extends InboxItemContext {
  kind: 'hitl';
  id: string;
  requestId: string;
  question: string;
  options?: string[];
  mode?: ClarifyChoiceMode;
  allowOther?: boolean;
  asker?: ClarifyAsker;
  autoResolutionMs?: number;
  expiresAt?: string;
  answer?: string;
  resolutionReason?: 'answered' | 'timeout' | 'cancelled';
}
```

`itemKey` is a stable namespaced identity:

- `mention:<messageId>`;
- `approval:<requestId>`;
- `hitl:<requestId>`.

`requiresResponse` is derived as `actionState === 'needs-response'`; it is not stored as a second source of truth.

Mentions are informational. Unresolved approvals and clarifications need a response. Resolved items remain queryable as completed history instead of disappearing immediately after an action.

### Read state

Read state is operator UI state, not message or event truth. Store it in a focused `inbox_item_reads` table:

```sql
CREATE TABLE inbox_item_reads (
  item_key TEXT PRIMARY KEY NOT NULL,
  read_at TEXT NOT NULL
);
```

The table intentionally stores no copied item payload. Inbox items continue to be projected from messages and durable events, then left-joined with this table. Marking an item read is an idempotent insert that preserves the earliest valid `read_at`.

The schema is single-operator by design because Monad currently has one local operator identity. A future multi-operator model would add `operator_id` to the key in a separate migration.

### HITL lifecycle

`clarify.requested` remains the durable creation fact and `clarify.resolved` remains the durable terminal fact. The requested payload gains:

```ts
{
  requestId: string;
  question: string;
  options?: string[];
  mode?: ClarifyChoiceMode;
  allowOther?: boolean;
  asker?: ClarifyAsker;
  autoResolutionMs?: number;
  expiresAt?: string;
}
```

`expiresAt` is calculated once from the daemon clock when the request is created. It, rather than a newly calculated duration, is used to restore timers after restart.

`clarify.resolved` records one of:

- `reason: 'answered'` with the submitted answer;
- `reason: 'timeout'` with an empty answer;
- `reason: 'cancelled'` with an empty answer.

There is exactly one terminal event per request. Competing answer, timeout, and cancellation paths use a store transaction or equivalent compare-and-set operation so only the first transition wins.

## QA tool contract

The daemon-owned tool input becomes:

```ts
interface ClarifyAskInput {
  question: string;
  options?: string[];
  autoResolutionMs?: number;
}
```

Rules:

- omitted `autoResolutionMs`: required human response, no automatic timer;
- supplied `autoResolutionMs`: integer from `60_000` through `240_000` milliseconds;
- timeout: resolve with an empty answer and tell the agent to proceed using its best judgment;
- required request: the tool remains suspended until answered, explicitly cancelled, or its owning session is deleted;
- aborting a transient HTTP client connection does not cancel a durable required request;
- explicit generation cancellation may cancel the in-memory waiter, but the product only emits terminal `cancelled` when the user cancels the owning task/session rather than merely navigating away.

The description tells the agent to omit `autoResolutionMs` when proceeding without an answer would be unsafe or would violate the user's intent. The bounded value is for useful but non-blocking context only.

Capacity protection must not turn required input into an empty answer. When the pending registry is at capacity, request creation fails with a typed tool error before emitting `clarify.requested`. Best-effort requests follow the same explicit failure behavior; the agent may then continue according to the tool error. Silent auto-resolution is removed.

## Durable waiting and restart recovery

The current `ClarifyService` keeps resolver functions and timers in memory. That remains a fast path, but durable events become the authority.

On daemon startup:

1. query unresolved `clarify.requested` events;
2. leave required requests unresolved;
3. for requests with `expiresAt` in the future, recreate a timer for the remaining duration;
4. for requests whose `expiresAt` has passed, attempt the atomic timeout transition;
5. register every unresolved request as answerable even if its original JavaScript promise no longer exists.

Daemon restart must stop producing `clarify.resolved(reason: 'daemon_restarted')` tombstones.

An answer after restart cannot recreate a lost JavaScript stack. Continuation therefore uses request origin metadata:

- for a still-live in-process generation, resolve its registered waiter normally;
- for a daemon-owned generation lost during restart, persist the answer and start an idempotent continuation turn in the same session with structured context containing the request ID, original question, and answer;
- for a managed native project ask, persist enough asker and mesh-session metadata on the request to enqueue the answered summary back to that runtime through its existing project Inbox delivery path;
- use `requestId`-derived idempotency keys so recovery cannot schedule the continuation twice.

This is continuation after a durable interrupt, not a claim that Monad can serialize and restore an arbitrary JavaScript promise.

## Inbox projection and persistence

The store projects items from existing truth:

- mentions from active assistant project messages containing a human mention;
- approvals from requested events without a matching resolved event, plus recent resolved events for Completed history;
- HITL from `clarify.requested`, left-joined to its terminal `clarify.resolved` event;
- read state from `inbox_item_reads`.

The projection applies the list filter before pagination and orders by `createdAt DESC`, using a stable cursor that includes the source row identity for equal timestamps. It must not concatenate independently limited source arrays because doing so can omit globally newer items.

Completed items remain available through the Completed filter. The default All view includes pending work and recent informational items but may use the existing limit. No retention or archival policy is added in this change.

## HTTP API

Introduce general Inbox endpoints:

```text
GET  /v1/inbox/items?filter=all|needs-response|unread|completed&limit=&cursor=
GET  /v1/inbox/summary
POST /v1/inbox/read
POST /v1/clarifications/respond
```

The response shapes include:

```ts
interface ListInboxResponse {
  items: InboxItem[];
  nextCursor?: string;
}

interface InboxSummary {
  unreadCount: number;
  needsResponseCount: number;
}

interface MarkInboxReadRequest {
  itemKeys: string[];
}

interface MarkInboxReadResponse {
  readAt: string;
  itemKeys: string[];
}
```

The summary counts distinct projected items, not raw events. `needsResponseCount` includes read and unread pending approvals/HITL. `unreadCount` includes unresolved and resolved items whose cards have not been meaningfully seen.

`POST /v1/clarifications/respond` returns the terminal state rather than only `ok`:

```ts
type ClarifyRespondResponse =
  | { status: 'answered'; answer: string; resolvedAt: string }
  | { status: 'timed-out'; resolvedAt: string }
  | { status: 'cancelled'; resolvedAt: string }
  | { status: 'not-found' };
```

Submitting the same answer twice or losing a race to timeout returns the existing terminal state. The UI treats this as refreshable state, not an exceptional transport failure.

Keep `GET /v1/inbox/mentions` temporarily as a compatibility route backed by the new projector. It preserves its existing response contract and does not expose cursor or mutation features. New Web code uses only `/v1/inbox/items` and `/v1/inbox/summary`.

## Web data flow and realtime updates

Add RTK Query endpoints and tags for Inbox items, summary, mark-read, and HITL response. Successful local mutations invalidate both the item list and summary.

Durable server events that can change Inbox state also invalidate those queries:

- creation or deactivation of a human mention;
- `tool.approval_requested` and `tool.approval_resolved`;
- `mesh.approval_requested` and `mesh.approval_resolved`;
- `clarify.requested` and `clarify.resolved`.

Realtime delivery is an invalidation signal, not a second client-side state machine. The Web client refetches the server projection instead of manually adding, removing, or resolving items from event payloads. Polling at a conservative interval remains a fallback when the global event connection is unavailable.

The sidebar fetches only `/v1/inbox/summary`; it does not fetch the first page of Inbox merely to calculate counts.

## Meaningful visibility and read mutation

Each unread Inbox card registers its primary content region with `react-intersection-observer` through a route-level visibility coordinator. The primary content region contains the title plus question or message preview; it excludes expandable form controls, action rows, and completed-detail sections. Observing this stable semantic region prevents a tall HITL form or resized option list from changing what counts as seeing the item.

An item becomes read only when all conditions hold:

- Inbox is the active route;
- `document.visibilityState === 'visible'`;
- at least 50% of the primary content region intersects the Inbox scroll root for 500 ms continuously.

Use `useOnInView` with the real Inbox scroll element as `root` and `threshold: 0.5`. The library and browser own scroll observation, window and container resize response, DOM ref replacement, and compatible observer reuse. Do not add `scroll` listeners or a separate `ResizeObserver` for read detection.

The coordinator starts the 500 ms business dwell timer from the library callback and cancels it when intersection, route activity, or document visibility stops holding. A brief edge intersection, background tab, route prefetch, initial data load, or hidden panel does not count. Unmounting or re-keying a content region cancels its timer; the already-read and queued-write sets remain keyed by stable `itemKey` rather than DOM identity.

When supported, the observer enables `trackVisibility` with an appropriate delay. The fallback uses normal intersection plus document and route visibility; correctness must not depend on the experimental property.

Newly read item keys are de-duplicated and submitted in small batches. The client may remove unread styling optimistically after the 500 ms threshold, but retains failed keys in a retry queue. A read-write failure never blocks approval or HITL response actions.

## Inbox UI

The page header offers four filters:

- All;
- Need response;
- Unread;
- Completed.

Rows behave by kind:

- mention: show the message preview, origin, timestamp, unread indicator, and open-session action;
- approval: show the requested action and Approve/Reject controls;
- HITL: show the question, options, optional free-text input, and Submit control;
- completed approval/HITL: show the terminal decision or answer summary and resolution time without active controls.

Submitting a response keeps the card in place while the mutation settles. On success it transitions to a completed presentation instead of disappearing from under the pointer. The current filter may remove it only after the settled UI has rendered and the server projection refreshes.

HITL input state is local and keyed by `requestId`. Background list refreshes must preserve a partially written answer. Controls disable only for the item being submitted, not the whole Inbox.

## Sidebar presentation

Sidebar priority is:

1. `needsResponseCount > 0`: highlighted Need response treatment;
2. otherwise `unreadCount > 0`: quiet unread dot or count;
3. otherwise: ordinary Inbox navigation row.

At normal width, the actionable badge reads `Need response · N`. At narrow width, the icon and `N` remain visible while the text clips. A tooltip and accessible name expose the complete label.

The default is static text. If the existing sidebar marquee primitive is reused for overflow discovery, movement must:

- begin only after deliberate pointer hover, never on load or focus alone;
- use the existing intent delay;
- run once to reveal the end, without looping or bouncing;
- stop and reset when the pointer leaves;
- remain paused while the pointer is stationary over the revealed end;
- be disabled under `prefers-reduced-motion: reduce`.

The badge must not use an assertive live region. Summary changes update normal accessible text without repeatedly interrupting screen-reader output.

## Error and race behavior

- Answer versus timeout: the first atomic terminal transition wins; the loser returns the stored result.
- Two browser windows answering: the first answer wins; both windows refresh to the same result.
- Already-resolved approval: refresh the item and summary; do not leave a permanent action error banner.
- Read mutation failure: retain or retry the pending batch; do not revert a successful human response.
- Realtime disconnect: retain server state and use polling/refetch; do not synthesize completion.
- Daemon restart: restore required pending items and expiry timers; do not resolve them as empty.
- Explicit session deletion: cancel unresolved HITL items for that session before deleting the owning state.
- Malformed historical event payload: skip the invalid item and continue projecting valid items; log diagnostics without failing the whole Inbox response.
- Item disappears between visibility and mark-read: accept the idempotent read write or ignore the stale key consistently; never fail the entire batch.

## Component boundaries

Keep responsibilities focused:

- protocol Inbox types own item, filter, summary, and mutation contracts;
- store Inbox projection owns cross-source aggregation and read-state joins;
- a HITL lifecycle store/service owns atomic resolution, expiry restoration, and continuation routing;
- HTTP controllers translate contracts only;
- RTK Query endpoints own fetching, invalidation tags, and mutations;
- an Inbox visibility hook owns intersection/dwell/batching behavior;
- Inbox item components own kind-specific rendering and local drafts;
- the sidebar consumes only the summary and owns badge presentation.

The visibility hook wraps `react-intersection-observer`; it does not construct `IntersectionObserver`, subscribe to scroll, or measure resize itself. Do not put dwell or batching logic directly into every row, and do not make the sidebar derive counts from page data.

## Testing

### Protocol

- parse mention, approval, and HITL item variants;
- reject `autoResolutionMs` below 60,000 or above 240,000;
- accept omission as required input;
- parse list filters, cursors, summary, read mutation, and terminal response variants.

### Store and lifecycle service

- globally order mixed item kinds before applying the limit;
- join read state and preserve the earliest `readAt` on repeated writes;
- count read pending work in `needsResponseCount` but not `unreadCount`;
- transition answer, timeout, and cancellation exactly once under races;
- restore a future expiry using the remaining duration;
- immediately time out an already-expired request on startup;
- leave required requests unresolved across restart;
- reject capacity overflow without returning an empty successful answer;
- route one idempotent post-restart continuation to the correct daemon or managed-native origin.

### HTTP and integration

- list and filter all item variants with stable pagination;
- answer HITL from Inbox and observe the live agent continue;
- answer a recovered HITL after simulated daemon restart and observe one continuation;
- return the existing terminal result for duplicate or raced responses;
- batch mark visible items read and return summary changes;
- keep the legacy mentions route contract compatible.

### Web unit tests

- mark after 50% visibility for 500 ms;
- do not mark on an edge intersection shorter than 500 ms;
- cancel dwell when the document becomes hidden or route changes;
- observe the stable primary content region rather than a variable-height HITL form;
- preserve the same threshold behavior across scroll-root resize and content-region remount;
- batch and de-duplicate item keys;
- preserve HITL drafts across refetch;
- render read and action states independently;
- render static/reduced-motion sidebar badge behavior.

### Playwright

- pending HITL appears in Inbox and as Need response in the sidebar;
- scrolling a card into meaningful view marks only that card read and persists after reload;
- a read but unanswered HITL still displays Need response;
- answering in Inbox completes the card and removes the actionable badge;
- an unseen completed item remains unread;
- narrow sidebar preserves icon/count and exposes the full accessible label;
- light, dark, reduced-motion, and keyboard flows remain usable.

Run related visibility and realtime Playwright files serially because timers, focus, and shared daemon event state make parallel execution nondeterministic.

## Migration and rollout

1. Add protocol fields, the read-state migration, and `react-intersection-observer@^10.1.0` to `apps/web` without switching the Web route.
2. Add lifecycle persistence, atomic terminal transitions, restart recovery, and tests.
3. Add general Inbox list/summary/read endpoints while keeping the legacy endpoint.
4. Move Web Inbox and sidebar to the new endpoints.
5. Add visibility-based read mutation and filters.
6. Remove restart tombstoning for clarify only after recovery tests prove required questions remain answerable.

Existing historical `clarify.requested` events lack `expiresAt`. Treat unresolved legacy requests found during the migration as cancelled legacy state rather than guessing that they were required. New requests created after the protocol change have explicit timeout semantics.

## Alternatives considered

### Materialize complete Inbox rows

Rejected for this scope. It simplifies reads but duplicates message and event payloads and introduces consistency work between source events and Inbox records. A focused read-state table preserves one source of truth for content.

### Represent read state as durable domain events

Rejected. Reading is frequent UI state, and emitting one durable event per viewed card would add noisy event volume and make summary queries more expensive without improving product semantics.

### Mark everything read when Inbox opens

Rejected. It violates the explicit requirement that an item counts as read only after the operator has seen it.

### Let the agent choose arbitrary timeout milliseconds

Rejected. A bounded auto-resolution window preserves agent judgment about whether a question is blocking without allowing accidental seconds-long expiry or multi-hour resource retention.

### Keep required waits only in memory

Rejected. Browser closure, transport loss, or daemon restart would discard or falsely resolve the human obligation. Durable events and origin-aware continuation are required.

### Continuously scroll Need response text

Rejected. Persistent marquee motion is distracting and creates accessibility obligations. Static clipping plus tooltip is the default; any overflow reveal is finite, intent-triggered, and reduced-motion aware.

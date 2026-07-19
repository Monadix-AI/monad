// Coverage guard for the push channels: every EventType the daemon can emit must be
// deliverable to a client over at least one channel. There are two:
//   • the WS control stream — METHOD_TABLE's subscribe methods declare `emits`;
//   • the per-session SSE generation stream (GET /v1/sessions/:id/events) — an HTTP-only
//     endpoint with no method-table entry, so its event set is declared explicitly below.
// Their union must equal the full EventType set, so a new event type added to the enum
// without wiring it into a channel fails here instead of silently being undeliverable.
// See docs/internals/realtime-channels.md for why generation rides SSE rather than a WS RPC.

import type { EventType } from '../src/domain.ts';

import { expect, test } from 'bun:test';

import { eventTypeSchema } from '../src/domain.ts';
import { METHOD_TABLE } from '../src/rpc/method-table.ts';

const ALL_EVENT_TYPES = new Set(eventTypeSchema.options);

// Generation/turn-scoped events the SSE endpoint streams from the per-session topic. Keep in
// sync with docs/internals/realtime-channels.md (data-plane list) — a new generation event type belongs here.
const SSE_GENERATION_EMITS: readonly EventType[] = [
  'session.message.delta.appended',
  'session.message.completed',
  'session.message.failed',
  'tool.called',
  'tool.progress',
  'tool.result',
  'tool.approval_requested',
  'tool.approval_resolved',
  'clarify.requested',
  'clarify.resolved',
  'context.usage',
  'context.evicted',
  'context.handoff_suggested',
  'memory.suggestion',
  'delegation.fs_request',
  'delegation.terminal_request',
  'mesh.started',
  'mesh.connection_required',
  'mesh.approval_requested',
  'mesh.approval_resolved',
  'mesh.idle_resumed',
  'mesh.idle_suspended',
  'mesh.resume_failed',
  'mesh.exited',
  'mesh.turn_settled',
  'mesh.login_required',
  'mesh.login_resolved'
];

function declaredEmits(): Set<string> {
  const union = new Set<string>();
  for (const def of Object.values(METHOD_TABLE)) {
    if ('emits' in def && def.emits) for (const t of def.emits) union.add(t);
  }
  return union;
}

test('every EventType is emitted by at least one subscribe channel', () => {
  const covered = declaredEmits();
  for (const t of SSE_GENERATION_EMITS) covered.add(t);
  const undeliverable = [...ALL_EVENT_TYPES].filter((t) => !covered.has(t));
  expect(undeliverable, 'event types delivered by neither a channel.emits nor the SSE stream').toEqual([]);
});

test('no emits entry names an unknown event type', () => {
  const declared = [...declaredEmits(), ...SSE_GENERATION_EMITS];
  const unknown = declared.filter((t) => !ALL_EVENT_TYPES.has(t as never));
  expect(unknown, 'emits entries that are not valid EventTypes').toEqual([]);
});

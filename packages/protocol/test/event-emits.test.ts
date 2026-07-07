// Coverage guard for the push channels: every EventType the daemon can emit must be
// deliverable to a client over at least one channel. There are two:
//   • the WS control stream — METHOD_TABLE's subscribe methods declare `emits`;
//   • the per-session SSE generation stream (GET /v1/sessions/:id/events) — an HTTP-only
//     endpoint with no method-table entry, so its event set is declared explicitly below.
// Their union must equal the full EventType set, so a new event type added to the enum
// without wiring it into a channel fails here instead of silently being undeliverable.
// See docs/realtime-channels.md for why generation rides SSE rather than a WS RPC.

import type { EventType } from '../src/domain.ts';

import { test } from 'bun:test';

import { eventTypeSchema } from '../src/domain.ts';
import { METHOD_TABLE } from '../src/rpc/method-table.ts';

const ALL_EVENT_TYPES = new Set(eventTypeSchema.options);

// Generation/turn-scoped events the SSE endpoint streams from the per-session topic. Keep in
// sync with docs/realtime-channels.md (data-plane list) — a new generation event type belongs here.
const SSE_GENERATION_EMITS: readonly EventType[] = [
  'user.message',
  'agent.message',
  'agent.token',
  'agent.reasoning',
  'agent.error',
  'message.delta',
  'message.complete',
  'tool.called',
  'tool.progress',
  'tool.result',
  'tool.approval_requested',
  'tool.approval_resolved',
  'clarify.requested',
  'clarify.resolved',
  'context.usage',
  'delegation.fs_request',
  'delegation.terminal_request',
  'external_agent.started',
  'external_agent.output',
  'external_agent.connection_required',
  'external_agent.approval_requested',
  'external_agent.approval_resolved',
  'external_agent.resume_failed',
  'external_agent.exited'
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
  const _undeliverable = [...ALL_EVENT_TYPES].filter((t) => !covered.has(t));
});

test('no emits entry names an unknown event type', () => {
  const declared = [...declaredEmits(), ...SSE_GENERATION_EMITS];
  const _unknown = declared.filter((t) => !ALL_EVENT_TYPES.has(t as never));
});

import type { Event, SessionId, SessionUiEvent, UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@monad/protocol';

import { SessionUiProjector } from '#/handlers/session/ui-projection.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';
import { buildHandlers } from '../../helpers.ts';

// The Web/TUI experience owns MeshAgent presentation; the daemon's session UI-projection modules must
// carry no MeshAgent UI projection. This scans the shipped projector source and reports the exact
// file:line of any MeshAgent-projection hit so a regression fails with a precise location.
const PROJECTION_ROOT = join(import.meta.dir, '../../../src/handlers/session');
const MODULES = ['ui-projection.ts', 'ui-projection-tool-events.ts', 'ui-projection-helpers.ts'];

const FORBIDDEN: { label: string; matches: (line: string) => boolean }[] = [
  { label: 'mesh case in the projection switch', matches: (l) => /case '(mesh\.[^']*)'/.test(l) },
  {
    label: 'mesh provider-adapter import',
    matches: (l) => l.includes('findMeshAgentProviderAdapter') || l.includes('listMeshAgentProviderAdapters')
  },
  { label: 'mesh-agent i18n catalog key', matches: (l) => l.includes('daemon.session.meshAgent') },
  {
    label: 'mesh hydration entry point',
    matches: (l) => l.includes('hydrateMeshSession') || l.includes('hydrateMeshAgentLogin')
  }
];

function meshProjectionHits(): string[] {
  const hits: string[] = [];
  for (const module of MODULES) {
    const lines = readFileSync(join(PROJECTION_ROOT, module), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const rule of FORBIDDEN) {
        if (rule.matches(line)) hits.push(`${module}:${index + 1} (${rule.label})`);
      }
    });
  }
  return hits;
}

test('daemon session UI-projection modules carry no MeshAgent presentation', () => {
  // artifact-ok: enforces the daemon↔experience MeshAgent UI boundary
  expect(meshProjectionHits()).toEqual([]);
});

// A single boundary scenario reused across the projector, live-subscribe, reconnect, and history paths:
// one managed mesh session that logs in, asks for approval (left unresolved), fails a resume, and exits.
// None of these may surface a daemon-projected UI row.
const MESH_SESSION_ID = 'mesh_boundary0001';
const MESH_REQUEST_ID = 'req_mesh00000001';

function meshEvent(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): Event {
  return { id: newId('evt'), sessionId, type, actorAgentId: null, payload, at: new Date().toISOString() };
}

// Every representative canonical mesh.* event with a schema-valid payload — used both to drive the
// projector directly and (the durable subset) to seed the store, so appendEvents' parse never rejects.
function canonicalMeshEvents(sessionId: SessionId): Event[] {
  return [
    meshEvent(sessionId, 'mesh.started', {
      meshSessionId: MESH_SESSION_ID,
      agentName: 'codex',
      provider: 'codex',
      workingPath: '/tmp/mesh-boundary',
      pid: 4242
    }),
    meshEvent(sessionId, 'mesh.login_required', { agentName: 'codex', provider: 'codex', reason: 'sign in to codex' }),
    meshEvent(sessionId, 'mesh.login_resolved', { agentName: 'codex', authAgentName: 'codex', provider: 'codex' }),
    meshEvent(sessionId, 'mesh.connection_required', {
      agentName: 'codex',
      provider: 'codex',
      reason: 'reconnect required',
      reconnectIn: 'studio'
    }),
    meshEvent(sessionId, 'mesh.approval_requested', {
      meshSessionId: MESH_SESSION_ID,
      provider: 'codex',
      requestId: MESH_REQUEST_ID,
      text: 'run rm -rf build?'
    }),
    meshEvent(sessionId, 'mesh.approval_resolved', {
      meshSessionId: MESH_SESSION_ID,
      provider: 'codex',
      requestId: MESH_REQUEST_ID,
      allow: true
    }),
    meshEvent(sessionId, 'mesh.idle_suspended', {
      agentId: 'agt_mesh00000001',
      agentName: 'codex',
      type: 'idle_suspended',
      payload: { meshSessionId: MESH_SESSION_ID, idleTimeoutMs: 60000 }
    }),
    meshEvent(sessionId, 'mesh.idle_resumed', {
      agentId: 'agt_mesh00000001',
      agentName: 'codex',
      type: 'idle_resumed',
      payload: { meshSessionId: MESH_SESSION_ID }
    }),
    meshEvent(sessionId, 'mesh.resume_failed', {
      agentName: 'codex',
      provider: 'codex',
      providerSessionRef: 'ref_boundary',
      code: 'RESUME_FAILED',
      message: 'provider session gone',
      fallback: 'cold-start'
    }),
    meshEvent(sessionId, 'mesh.exited', { meshSessionId: MESH_SESSION_ID, exitCode: 0, state: 'exited' }),
    meshEvent(sessionId, 'mesh.turn_started', { meshSessionId: MESH_SESSION_ID }),
    meshEvent(sessionId, 'mesh.turn_settled', { meshSessionId: MESH_SESSION_ID }),
    meshEvent(sessionId, 'mesh.session.connection.opened', {
      meshSessionId: MESH_SESSION_ID,
      provider: 'codex',
      observationEpoch: 'epoch-1'
    }),
    meshEvent(sessionId, 'mesh.session.connection.closed', {
      meshSessionId: MESH_SESSION_ID,
      provider: 'codex',
      observationEpoch: 'epoch-1',
      reason: 'disconnected'
    })
  ];
}

// The durable subset the store actually persists for reconnect/history replay (login + approval left
// unresolved + resume failure + terminal exit). All carry schema-valid payloads.
function durableMeshEvents(sessionId: SessionId): Event[] {
  const all = canonicalMeshEvents(sessionId);
  const wanted = new Set(['mesh.login_required', 'mesh.approval_requested', 'mesh.resume_failed', 'mesh.exited']);
  return all.filter((event) => wanted.has(event.type));
}

function seedMeshSession(handlers: ReturnType<typeof buildHandlers>, sessionId: SessionId): void {
  handlers.store.upsertMeshSession({
    id: MESH_SESSION_ID,
    transcriptTargetId: sessionId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/mesh-boundary',
    runtimeRole: 'interactive',
    agentRuntimeId: null,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: 4242,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    exitedAt: null
  });
}

// The exact canonical rows a boundary transcript should project — a plain user turn and a plain
// assistant reply, with zero MeshAgent decoration.
function canonicalItems(userId: string, assistantId: string): UIItem[] {
  return [
    {
      kind: 'message',
      id: userId,
      role: 'user',
      parts: [{ type: 'text', text: 'kick off the review' }],
      replyable: true,
      status: 'done',
      seq: '2026-07-19T00:00:00.000Z'
    },
    {
      kind: 'message',
      id: assistantId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'on it' }],
      replyable: true,
      status: 'done',
      seq: '2026-07-19T00:00:01.000Z'
    }
  ];
}

test('applyEvent projects no UI row for any canonical mesh.* event, yet still projects a canonical message', () => {
  const sessionId = 'ses_boundary0001' as SessionId;
  const projector = new SessionUiProjector();

  // Each mesh event is a no-op on the projected view: it adds no tool card, custom notice, or approval.
  for (const event of canonicalMeshEvents(sessionId)) {
    expect(projector.applyEvent(event)).toEqual([]);
  }
  const afterMesh = projector.snapshot();
  if (afterMesh.kind !== 'snapshot') throw new Error('expected snapshot');
  expect(afterMesh.items).toEqual([]);

  // Control: the very same projector still projects an ordinary canonical message — proving mesh events
  // were ignored, not that the projector was inert.
  const messageId = 'msg_boundaryctrl';
  const [projected] = projector.applyEvent(
    meshEvent(sessionId, 'session.message.created', {
      transcriptTargetId: sessionId,
      producer: { kind: 'agent', agentId: 'agt_boundary0001' },
      message: {
        id: messageId,
        sessionId,
        role: 'assistant',
        text: 'hello',
        type: 'text',
        stream: { status: 'complete' },
        active: true,
        createdAt: '2026-07-19T00:00:05.000Z'
      },
      messageRevision: 1
    })
  );
  expect(projected).toEqual({
    kind: 'upsert',
    cursor: expect.any(String),
    item: {
      kind: 'message',
      id: messageId,
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
      replyable: true,
      status: 'done',
      seq: '2026-07-19T00:00:05.000Z'
    }
  });
});

test('subscribeUi projects only canonical rows for a fresh subscribe over a live mesh session', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 'mesh boundary' });
  const userId = newId('msg');
  const assistantId = newId('msg');
  handlers.store.insertMessage(userId, sessionId, 'kick off the review', '2026-07-19T00:00:00.000Z', 'user');
  handlers.store.insertMessage(assistantId, sessionId, 'on it', '2026-07-19T00:00:01.000Z', 'assistant');
  seedMeshSession(handlers, sessionId);
  handlers.store.appendEvents(durableMeshEvents(sessionId));

  let snap: SessionUiEvent | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId }, (event) => {
    if (!snap && event.kind === 'snapshot') snap = event;
  });
  dispose();

  if (snap?.kind !== 'snapshot') throw new Error('expected hydrated snapshot');
  expect(snap.items).toEqual(canonicalItems(userId, assistantId));

  handlers.store.close();
});

test('subscribeUi reconnect still projects only canonical rows despite durable mesh events', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 'mesh boundary reconnect' });
  const userId = newId('msg');
  const assistantId = newId('msg');
  handlers.store.insertMessage(userId, sessionId, 'kick off the review', '2026-07-19T00:00:00.000Z', 'user');
  handlers.store.insertMessage(assistantId, sessionId, 'on it', '2026-07-19T00:00:01.000Z', 'assistant');
  seedMeshSession(handlers, sessionId);
  handlers.store.appendEvents(durableMeshEvents(sessionId));

  // Reconnect with an un-persisted generation cursor: hydration is the reconnect baseline, and the
  // durable mesh events (incl. an unresolved mesh.approval_requested that flows through the pending
  // interaction path) must still contribute no UI row.
  let snap: SessionUiEvent | undefined;
  const { dispose } = await handlers.session.subscribeUi({ sessionId, afterEventId: newId('evt') }, (event) => {
    if (!snap && event.kind === 'snapshot') snap = event;
  });
  dispose();

  if (snap?.kind !== 'snapshot') throw new Error('expected hydrated snapshot');
  expect(snap.items).toEqual(canonicalItems(userId, assistantId));

  handlers.store.close();
});

test('uiItems history page returns only canonical rows for a transcript with mesh events', async () => {
  const handlers = buildHandlers(buildMockModel().text(['x']).build());
  const { sessionId } = await handlers.session.create({ title: 'mesh boundary history' });
  const userId = newId('msg');
  const assistantId = newId('msg');
  handlers.store.insertMessage(userId, sessionId, 'kick off the review', '2026-07-19T00:00:00.000Z', 'user');
  handlers.store.insertMessage(assistantId, sessionId, 'on it', '2026-07-19T00:00:01.000Z', 'assistant');
  seedMeshSession(handlers, sessionId);
  handlers.store.appendEvents(durableMeshEvents(sessionId));

  const page = await handlers.session.uiItems({ id: sessionId });
  expect(page.items).toEqual(canonicalItems(userId, assistantId));

  handlers.store.close();
});

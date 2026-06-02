import type { ChatMessage, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@monad/protocol';

import { createManagedMeshAgentMessages } from '#/handlers/session/handlers/managed-mesh-agent-messages.ts';
import { EventBus } from '#/services/event-bus.ts';
import { createMessageIngress } from '#/services/messages/ingress.ts';
import { createStore } from '#/store/db/index.ts';

const AT = '2026-07-25T00:00:00.000Z';

function session(id: SessionId): Session {
  return {
    id,
    projectId: 'prj_placeholder1',
    title: 't',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    activityAt: AT,
    createdAt: AT,
    updatedAt: AT
  };
}

// A managed-mesh-agent placeholder as it was emitted BEFORE the cutover: keyed by the runtime alias
// ('codex') in data.memberId/agentName, not the canonical projectMemberId ('pmem_codex').
function legacyPlaceholder(
  sessionId: SessionId,
  meshSessionId: string,
  id: `msg_${string}`,
  streaming: boolean
): ChatMessage {
  return {
    id,
    sessionId,
    role: 'assistant',
    text: '',
    type: 'text',
    data: {
      source: 'managed-mesh-agent',
      meshSessionId,
      memberId: 'codex',
      agentName: 'codex',
      agentDisplayName: 'Codex'
    },
    stream: streaming
      ? { status: 'streaming', source: { transcriptTargetId: sessionId, messageId: id } }
      : { status: 'settled' },
    active: true,
    includeInContext: false,
    createdAt: AT
  } as ChatMessage;
}

// Reopen the persisted DB in a FRESH process-equivalent: a new store + a new messages handler whose
// in-memory pending map starts empty, so completion/retire must recover the placeholder from SQLite.
function reopen(path: string) {
  const store = createStore({ path });
  const bus = new EventBus();
  const messageIngress = createMessageIngress({ store, bus, targetExists: () => true, fanout: () => {} });
  const messages = createManagedMeshAgentMessages({
    deps: { store },
    messageIngress,
    makeEmit: () => () => {},
    persistAndRetire: () => {},
    managedAgentSessions: undefined
  } as unknown as SessionContext);
  return { store, messages };
}

function managedMessages(store: ReturnType<typeof createStore>, sessionId: SessionId, meshSessionId: string) {
  return store
    .listMessages(sessionId, { latest: true, limit: 100 })
    .filter(
      (m) =>
        (m.data as { source?: string }).source === 'managed-mesh-agent' &&
        (m.data as { meshSessionId?: string }).meshSessionId === meshSessionId
    );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monad-placeholder-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('after a real close then reopen, completing by projectMemberId reuses the alias-keyed active placeholder', async () => {
  const path = join(dir, 'store.db');
  const sessionId = 'ses_reopenc00001' as SessionId;
  const meshSessionId = 'mesh_reopen0000c1';
  const placeholderId = 'msg_reopenc00001' as const;

  const seed = createStore({ path });
  seed.insertSession(session(sessionId));
  seed.createMessage({
    message: legacyPlaceholder(sessionId, meshSessionId, placeholderId, true),
    idempotencyKey: newId('idem'),
    fingerprint: 'seed:active-complete'
  });
  seed.close();

  const { store, messages } = reopen(path);
  try {
    const result = await messages.completeManagedMeshAgentThinking({
      sessionId,
      meshSessionId,
      agentName: 'pmem_codex',
      text: 'Final answer'
    });

    // Same row reused; data converged to the canonical member; still exactly one managed message (no orphan).
    expect(result.messageId).toBe(placeholderId);
    const settled = store.getMessage(sessionId, placeholderId);
    if (!settled) throw new Error('placeholder message missing after reopen');
    const settledData = settled.data as { memberId?: string; agentName?: string };
    expect({
      id: settled.id,
      streaming: settled.stream.status,
      active: settled.active,
      text: settled.text,
      memberId: settledData.memberId,
      agentName: settledData.agentName
    }).toEqual({
      id: placeholderId,
      streaming: 'complete',
      active: true,
      text: 'Final answer',
      memberId: 'pmem_codex',
      agentName: 'pmem_codex'
    });
    expect(managedMessages(store, sessionId, meshSessionId).map((m) => m.id)).toEqual([placeholderId]);
  } finally {
    store.close();
  }
});

test('after a real close then reopen, retiring by projectMemberId removes the alias-keyed active placeholder', async () => {
  const path = join(dir, 'store.db');
  const sessionId = 'ses_reopenr00001' as SessionId;
  const meshSessionId = 'mesh_reopen0000r1';
  const placeholderId = 'msg_reopenr00001' as const;

  const seed = createStore({ path });
  seed.insertSession(session(sessionId));
  seed.createMessage({
    message: legacyPlaceholder(sessionId, meshSessionId, placeholderId, true),
    idempotencyKey: newId('idem'),
    fingerprint: 'seed:active-retire'
  });
  seed.close();

  const { store, messages } = reopen(path);
  try {
    const retiredId = await messages.retireManagedMeshAgentThinking(sessionId, meshSessionId, 'pmem_codex');

    // The same row is retired (soft-deleted) and no active placeholder is left behind.
    expect(retiredId).toBe(placeholderId);
    expect(store.getMessage(sessionId, placeholderId)?.active).toBe(false);
    expect(managedMessages(store, sessionId, meshSessionId).filter((m) => m.active)).toEqual([]);
  } finally {
    store.close();
  }
});

test('after a real close then reopen, a settled historical placeholder is not re-located or rewritten', async () => {
  const path = join(dir, 'store.db');
  const sessionId = 'ses_reopens00001' as SessionId;
  const meshSessionId = 'mesh_reopen0000s1';
  const settledId = 'msg_reopens00001' as const;

  const seed = createStore({ path });
  seed.insertSession(session(sessionId));
  seed.createMessage({
    message: {
      ...legacyPlaceholder(sessionId, meshSessionId, settledId, false),
      text: 'historical answer'
    } as ChatMessage,
    idempotencyKey: newId('idem'),
    fingerprint: 'seed:settled'
  });
  seed.close();

  const before = createStore({ path });
  const snapshot = before.getMessage(sessionId, settledId);
  before.close();

  const { store, messages } = reopen(path);
  try {
    // A settled row is history: the streaming locator never returns it, so retire is a strict no-op that
    // leaves the row byte-identical and adds no message.
    expect(store.findManagedMeshAgentStreamingMessage(sessionId, meshSessionId)).toBeNull();
    const retiredId = await messages.retireManagedMeshAgentThinking(sessionId, meshSessionId, 'pmem_codex');
    expect(retiredId).toBeNull();
    expect(store.getMessage(sessionId, settledId)).toEqual(snapshot);
    expect(managedMessages(store, sessionId, meshSessionId)).toEqual(snapshot ? [snapshot] : []);
  } finally {
    store.close();
  }
});

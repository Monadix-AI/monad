import type { Event, ProjectId, Session, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createProjectSessionOperations } from '#/atoms/experience-project-sessions.ts';
import { createStore } from '#/store/db/index.ts';

const projectId = 'prj_100000000000' as ProjectId;
const sessionId = 'ses_100000000000' as SessionId;

function fixture(generate: () => Promise<void> = async () => {}) {
  const store = createStore();
  const now = '2026-07-14T00:00:00.000Z';
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Project',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now
  });
  store.insertSession({
    id: sessionId,
    projectId,
    title: 'Task',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now
  } satisfies Session);
  let generated = 0;
  const createRequests: unknown[] = [];
  const operations = createProjectSessionOperations({
    store,
    sessions: {
      createProjectSession: async (request: unknown) => {
        createRequests.push(request);
        return { sessionId };
      },
      generate: async () => {
        generated++;
        await generate();
      }
    } as never,
    oversight: {
      listPendingRequests: () => [],
      respond: async () => true
    } as never
  });
  return { store, operations, generated: () => generated, createRequests };
}

test('empty member policy is forwarded to daemon project-session creation', async () => {
  const { store, operations, createRequests } = fixture();

  try {
    await operations.create(projectId, {
      title: 'Manual roster',
      idempotencyKey: 'pack-a:create-a',
      memberPolicy: 'empty'
    } as Parameters<typeof operations.create>[1]);
    expect(createRequests).toEqual([
      {
        projectId,
        title: 'Manual roster',
        cwd: undefined,
        id: expect.stringMatching(/^ses_/),
        memberPolicy: 'empty'
      }
    ]);
  } finally {
    store.close();
  }
});

test('run snapshots stay daemon-authoritative through completion', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { store, operations } = fixture(() => pending);

  try {
    const { runId } = await operations.runTurn(sessionId, { text: 'Design it', idempotencyKey: 'stage-a' });
    expect(await operations.getRun(sessionId, 'missing')).toBeNull();

    let active = await operations.getRun(sessionId, runId);
    for (let attempt = 0; active?.state === 'scheduled' && attempt < 20; attempt++) {
      await Bun.sleep(0);
      active = await operations.getRun(sessionId, runId);
    }
    expect(active).toEqual({ id: runId, state: 'running' });

    finish();
    let completed = await operations.getRun(sessionId, runId);
    for (let attempt = 0; completed?.state !== 'completed' && attempt < 20; attempt++) {
      await Bun.sleep(0);
      completed = await operations.getRun(sessionId, runId);
    }
    expect(completed).toEqual({ id: runId, state: 'completed' });
  } finally {
    store.close();
  }
});

test('listObservations returns a neutral summary without raw tool payload values', async () => {
  const { store, operations } = fixture();
  store.appendEvents([
    {
      id: 'evt_100000000000' as Event['id'],
      sessionId,
      type: 'tool.called',
      actorAgentId: null,
      payload: { toolCallId: 'call_a', tool: 'shell_exec', input: { apiKey: 'top-secret' } },
      at: '2026-07-14T00:00:01.000Z'
    }
  ]);

  try {
    const result = await operations.listObservations(sessionId);
    expect(result.items[0]?.text).toContain('shell_exec');
    expect(result.items[0]?.text).not.toContain('top-secret');
  } finally {
    store.close();
  }
});

test('listArtifacts exposes sanitized member-authored attachment metadata to experiences', async () => {
  const { store, operations } = fixture();
  store.insertMessage('msg_100000000000', sessionId, 'Published design', '2026-07-14T00:00:01.000Z', 'assistant', {
    data: {
      memberId: 'pmem_host0000001',
      attachments: [
        { name: 'product-design.md', path: '/workspace/product-design.md', mime: 'text/markdown', secret: 'drop' },
        { name: 'invalid-without-path.md' }
      ],
      privateRuntimeState: 'drop'
    }
  });

  try {
    expect(await operations.listArtifacts?.(sessionId)).toEqual([
      {
        messageId: 'msg_100000000000',
        memberId: 'pmem_host0000001',
        name: 'product-design.md',
        path: '/workspace/product-design.md',
        mime: 'text/markdown',
        createdAt: '2026-07-14T00:00:01.000Z'
      }
    ]);
  } finally {
    store.close();
  }
});

test('sendMessage executes a namespaced idempotency key only once', async () => {
  const { store, operations, generated } = fixture();

  try {
    const request = { text: 'Hello', idempotencyKey: 'pack-a:request-a' };
    await operations.sendMessage(sessionId, request);
    await operations.sendMessage(sessionId, request);
    expect(generated()).toBe(1);
  } finally {
    store.close();
  }
});

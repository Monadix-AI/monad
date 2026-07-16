import type { ProjectId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { monadPowerPack } from '@monad/monad-power-pack';
import { loadManifestAtomPack } from '@monad/sdk-atom';

import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport } from '../helpers.ts';

const projectId = 'prj_kanbanproj1' as ProjectId;

async function harness() {
  const registry = new AtomPackRegistry();
  const permissions = monadPowerPack.manifest.permissions ?? [];
  await loadManifestAtomPack(monadPowerPack, {
    registerConnector: () => {},
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerSandbox: () => {},
    registerWorkspaceExperience: (experience) => registry.registerWorkspaceExperience(experience, 'monad-power-pack'),
    registerWorkspaceExperienceApi: (api) =>
      registry.registerWorkspaceExperienceApi(api, 'monad-power-pack', permissions),
    registerExperienceWorker: (worker) => registry.registerExperienceWorker(worker, 'monad-power-pack', permissions)
  });

  const store = createStore();
  const now = new Date().toISOString();
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Kanban project',
    state: 'active',
    archived: false,
    memberTemplates: [],
    createdAt: now,
    updatedAt: now
  });
  const handlers = buildHandlers(mockModel(), undefined, {
    store,
    getWorkspaceExperienceApiRoute: (experienceId, method, path) =>
      registry.getWorkspaceExperienceApiRoute(experienceId, method, path),
    getExperienceWorkers: () => [...registry.experienceWorkers.values()]
  });
  const live = serveTransport('tcp', createHttpTransport(handlers));
  const apiBase = '/v1/atoms/workspace-experiences/kanban/api';
  const post = async (path: string, body: unknown) => {
    const response = await live.fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(json));
    return json as { task: Record<string, unknown> };
  };
  const list = async () => {
    const response = await live.fetch(`${apiBase}/tasks?projectId=${projectId}`);
    return (await response.json()) as { tasks: Array<Record<string, unknown>> };
  };
  return { live, store, post, list };
}

test('two Kanban tasks use two project sessions in one shared Experience', async () => {
  const { live, store, post, list } = await harness();
  try {
    const first = await post('/tasks/create', { projectId, title: 'A', idempotencyKey: 'A' });
    const second = await post('/tasks/create', { projectId, title: 'B', idempotencyKey: 'B' });

    expect(first.task.sessionId).not.toBe(second.task.sessionId);
    expect((await list()).tasks.map((task) => task.id)).toEqual([first.task.id, second.task.id]);
    expect(store.listSessions({ projectId })).toHaveLength(2);
  } finally {
    await live.stop();
    store.close();
  }
});

test('proposal approval runs autopilot and acceptance return requeues execution', async () => {
  const { live, store, post, list } = await harness();
  try {
    const created = await post('/tasks/create', { projectId, title: 'A', idempotencyKey: 'A' });
    const taskId = String(created.task.id);
    await post('/proposals/submit', {
      projectId,
      taskId,
      expectedVersion: 0,
      summary: 'Ship A',
      acceptanceCriteria: ['tests pass']
    });
    await post('/proposals/decide', { projectId, taskId, expectedVersion: 1, decision: 'approve' });

    let task: Record<string, unknown> | undefined;
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      task = (await list()).tasks.find((candidate) => candidate.id === taskId);
      if (task?.stage === 'acceptance') break;
      await Bun.sleep(50);
    }
    expect(task).toMatchObject({ stage: 'acceptance', executionState: 'succeeded' });
    if (!task) throw new Error('task did not reach acceptance');

    const returned = await post('/acceptance/decide', {
      projectId,
      taskId,
      expectedVersion: task.version,
      decision: 'return',
      reason: 'add regression case'
    });
    expect(returned.task).toMatchObject({
      stage: 'execution',
      executionState: 'queued',
      returnReason: 'add regression case'
    });
  } finally {
    await live.stop();
    store.close();
  }
});

import type { ProjectId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/environment';
import { monadPowerPack } from '@monad/monad-power-pack';
import { newId } from '@monad/protocol';
import { loadManifestAtomPack } from '@monad/sdk-atom';

import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import { InteractionService } from '#/interactions/service.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { DAEMON_E2E_TIMEOUT_BUDGET } from '../../scripts/e2e-timeout-budget.ts';
import {
  buildHandlers,
  mockModel,
  serveTransport,
  stubConfigAccess,
  TRANSPORTS,
  type TransportKind
} from '../helpers.ts';
import { waitFor } from '../wait.ts';

async function harness(kind: TransportKind = 'tcp') {
  // A fresh project per harness: the power pack's experience workers run on real timers and are not
  // cancelled when a test closes its store, so a stray wake-up from an earlier test must not be able
  // to address the project the current test is asserting on.
  const projectId = newId('prj') as ProjectId;
  const registry = new AtomPackRegistry();
  const permissions = monadPowerPack.manifest.permissions ?? [];
  await loadManifestAtomPack(monadPowerPack, {
    registerConnector: () => {},
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerSandbox: () => {},
    registerWorkplaceExperience: (experience) => registry.registerWorkplaceExperience(experience, 'monad-power-pack'),
    registerWorkplaceExperienceApi: (api) =>
      registry.registerWorkplaceExperienceApi(api, 'monad-power-pack', permissions),
    registerExperienceWorker: (worker) => registry.registerExperienceWorker(worker, 'monad-power-pack', permissions)
  });

  const store = createStore();
  const interactions = new InteractionService({
    createId: () => 'interaction-kanban-remove',
    createLeaseToken: () => 'lease-kanban-remove'
  });
  const now = new Date().toISOString();
  const config = createDefaultConfig('kanban-test');
  config.meshAgents = [
    {
      name: 'codex',
      provider: 'codex',
      command: 'codex',
      enabled: true,
      allowAutopilot: true,
      approvalOwnership: 'provider-owned'
    }
  ];
  store.insertWorkplaceProject({
    id: projectId,
    title: 'Kanban project',
    state: 'active',
    archived: false,
    memberTemplates: [
      {
        id: 'tmpl_codex',
        type: 'mesh-agent',
        name: 'codex',
        displayName: 'Codex'
      }
    ],
    createdAt: now,
    updatedAt: now
  });
  const handlers = buildHandlers(mockModel(), undefined, {
    store,
    interactions,
    sessionDeleteGraceMs: 0,
    configManager: stubConfigAccess(config),
    getWorkplaceExperienceApiRoute: (experienceId, method, path) =>
      registry.getWorkplaceExperienceApiRoute(experienceId, method, path),
    getExperienceWorkers: () => [...registry.experienceWorkers.values()]
  });
  const live = serveTransport(kind, createHttpTransport(handlers));
  const apiBase = '/v1/atoms/workplace-experiences/kanban/api';
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
  return { interactions, live, store, post, list, projectId };
}

test('two Kanban tasks use two project sessions in one shared Experience', async () => {
  const { live, store, post, list, projectId } = await harness();
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

for (const kind of TRANSPORTS) {
  test(`deleting a project session removes its Kanban task through the Experience event subscription over ${kind}`, async () => {
    const { live, store, post, list, projectId } = await harness(kind);
    try {
      const created = await post('/tasks/create', { projectId, title: 'A', idempotencyKey: 'A' });
      const sessionId = String(created.task.sessionId);

      const response = await live.fetch(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
      expect(response.status).toBe(200);

      await waitFor(() => store.listExperienceState('monad-power-pack', projectId, 'task/').length === 0, {
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.conditionMs,
        message: 'deleting the session never removed its Kanban task state'
      });

      expect(store.listExperienceState('monad-power-pack', projectId, 'task/')).toEqual([]);
      expect(store.listExperienceState('monad-power-pack', projectId, 'provision/')).toEqual([]);
      expect((await list()).tasks).toEqual([]);
    } finally {
      await live.stop();
      store.close();
    }
  });
}

test('member assignment and confirmed removal are inert until Start and moving requires a new explicit Start', async () => {
  const { interactions, live, store, post, list, projectId } = await harness();
  try {
    const created = await post('/tasks/create', { projectId, title: 'A', idempotencyKey: 'A' });
    const taskId = String(created.task.id);
    const sessionId = String(created.task.sessionId);
    expect(created.task).toMatchObject({
      stage: 'product_design',
      members: [],
      availableActions: { start: false, moveNext: false }
    });
    expect(store.listSessionMembers(sessionId)).toEqual([]);
    expect(store.listMessages(sessionId)).toEqual([]);

    const assigned = await post('/tasks/members', {
      projectId,
      taskId,
      templateId: 'tmpl_codex',
      role: 'host'
    });
    // Template assignment mints a fresh per-instance member id; the template stays as its reference.
    const assignedMemberId = (assigned.task as { host: { member: { id: string } } }).host.member.id;
    expect(assignedMemberId).toMatch(/^pmem_/);
    expect(assigned.task).toMatchObject({
      version: 1,
      host: {
        member: {
          id: assignedMemberId,
          profileId: 'tmpl_codex',
          displayName: 'Codex'
        },
        binding: {
          projectMemberId: assignedMemberId,
          lifecycle: 'active'
        }
      },
      members: [],
      availableActions: { start: true, moveNext: false }
    });
    expect(store.listSessionMembers(sessionId)).toHaveLength(1);
    expect(store.listMessages(sessionId)).toEqual([]);

    const removal = post('/tasks/members/remove', { projectId, taskId, memberId: assignedMemberId });
    await waitFor(() => interactions.listPending().length > 0, {
      timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.conditionMs,
      message: 'member removal never raised its confirmation interaction'
    });
    const pending = interactions.listPending()[0];
    expect(pending).toMatchObject({
      id: 'interaction-kanban-remove',
      source: { kind: 'atom-pack', packId: 'monad-power-pack', atomId: 'kanban' },
      request: {
        type: 'confirm',
        title: 'Remove member?',
        description: 'Remove Codex from A?',
        confirmLabel: 'Remove'
      },
      mode: 'foreground'
    });
    if (!pending) throw new Error('remove confirmation was not requested');
    const claimed = interactions.claim(pending.id, 'web-test', {
      interactionTypes: ['confirm'],
      fieldTypes: [],
      supportsSecretInput: false,
      supportsBackgroundQueue: false
    });
    interactions.submit(pending.id, claimed.leaseToken, { confirmed: true });
    const removed = await removal;
    expect(removed).toMatchObject({
      deleted: true,
      task: { version: 2, host: null, members: [], availableActions: { start: false, moveNext: false } }
    });
    expect(store.listSessionMembers(sessionId)).toEqual([]);
    expect(store.listMessages(sessionId)).toEqual([]);

    const reassigned = await post('/tasks/members', { projectId, taskId, templateId: 'tmpl_codex', role: 'host' });
    const reassignedMemberId = (reassigned.task as { host: { member: { id: string } } }).host.member.id;
    expect(reassigned.task).toMatchObject({
      version: 3,
      host: { member: { id: reassignedMemberId } },
      availableActions: { start: true, moveNext: false }
    });

    await post('/tasks/start', { projectId, taskId, expectedVersion: 3 });

    let task: Record<string, unknown> | undefined;
    await waitFor(
      async () => {
        task = (await list()).tasks.find((candidate) => candidate.id === taskId);
        return task?.displayState === 'ready';
      },
      {
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.conditionMs,
        intervalMs: 10,
        message: 'task never finished Product Design'
      }
    );
    store.insertMessage(newId('msg'), sessionId, 'Published product design', new Date().toISOString(), 'assistant', {
      data: {
        memberId: reassignedMemberId,
        attachments: [
          {
            name: 'product-design.md',
            path: `/workspace/sessions/${sessionId}/docs/kanban/${taskId}/product-design.md`,
            mime: 'text/markdown'
          }
        ]
      }
    });
    task = (await list()).tasks.find((candidate) => candidate.id === taskId);
    expect(task).toMatchObject({
      stage: 'product_design',
      version: 4,
      displayState: 'ready',
      availableActions: { start: false, moveNext: true }
    });
    if (!task) throw new Error('task did not finish Product Design');

    const moved = await post('/tasks/move', {
      projectId,
      taskId,
      expectedVersion: task.version,
      destination: 'tech_design'
    });
    expect(moved.task).toMatchObject({
      stage: 'tech_design',
      version: 5,
      displayState: 'waiting',
      availableActions: { start: true, moveNext: false }
    });
    // biome-ignore lint/plugin: no event marks work that must NOT happen; the delay gives it its chance to appear before the assertion denies it.
    await Bun.sleep(100);
    expect((await list()).tasks.find((candidate) => candidate.id === taskId)).toMatchObject({
      stage: 'tech_design',
      version: 5,
      displayState: 'waiting',
      availableActions: { start: true, moveNext: false }
    });
  } finally {
    await live.stop();
    store.close();
  }
});

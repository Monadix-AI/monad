import { expect, test } from 'bun:test';

import {
  assignTaskHostProjection,
  clearTaskHostProjection,
  KANBAN_STAGES,
  makeKanbanTaskProjection,
  moveTaskProjection,
  normalizeTaskProjection
} from '../../src/experiences/kanban/domain.ts';

test('Kanban stages have one exact forward order', () => {
  expect(KANBAN_STAGES).toEqual(['product_design', 'tech_design', 'implementation', 'verify', 'completed']);
});

test('new projections wait in Product Design and move only one stage forward', () => {
  const created = makeKanbanTaskProjection({
    id: 'task-a',
    projectId: 'prj_a',
    sessionId: 'ses_a',
    title: 'A',
    createdAt: '2026-07-22T00:00:00.000Z'
  });
  const started = { ...created, stageRunId: 'run-product' };

  expect(created).toEqual({
    schemaVersion: 3,
    id: 'task-a',
    projectId: 'prj_a',
    sessionId: 'ses_a',
    title: 'A',
    stage: 'product_design',
    hostMemberId: null,
    stageRunId: null,
    version: 0,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z'
  });
  expect(moveTaskProjection(started, 0, 'tech_design', '2026-07-22T00:01:00.000Z')).toMatchObject({
    stage: 'tech_design',
    stageRunId: null,
    version: 1
  });
  expect(() => moveTaskProjection(started, 0, 'implementation', '2026-07-22T00:01:00.000Z')).toThrow(
    'only move to the next Kanban stage'
  );
});

test('Kanban projections cannot move backward or beyond Completed', () => {
  const base = makeKanbanTaskProjection({ id: 'task-a', projectId: 'prj_a', sessionId: 'ses_a', title: 'A' });
  const tech = { ...base, stage: 'tech_design' as const, version: 2 };
  const completed = { ...base, stage: 'completed' as const, version: 4 };

  expect(() => moveTaskProjection(tech, 2, 'product_design', '2026-07-22T00:00:00.000Z')).toThrow(
    'only move to the next Kanban stage'
  );
  expect(() => moveTaskProjection(completed, 4, 'completed', '2026-07-22T00:00:00.000Z')).toThrow(
    'Completed is terminal'
  );
});

test('legacy lifecycle records normalize to five-stage projections without losing the session', () => {
  const legacy = {
    schemaVersion: 1,
    id: 'task-a',
    projectId: 'prj_a',
    sessionId: 'ses_a',
    title: 'A',
    stage: 'acceptance',
    version: 7,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:01:00.000Z'
  };

  expect(normalizeTaskProjection(legacy)).toEqual({
    schemaVersion: 3,
    id: 'task-a',
    projectId: 'prj_a',
    sessionId: 'ses_a',
    title: 'A',
    stage: 'verify',
    hostMemberId: null,
    stageRunId: null,
    version: 7,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:01:00.000Z'
  });
  expect(
    ['requirements', 'execution', 'acceptance', 'completed'].map(
      (stage) => normalizeTaskProjection({ ...legacy, stage }).stage
    )
  ).toEqual(['product_design', 'implementation', 'verify', 'completed']);
});

test('version two projections retain an in-flight stage run while adding the host slot', () => {
  const previous = {
    schemaVersion: 2,
    id: 'task-a',
    projectId: 'prj_a',
    sessionId: 'ses_a',
    title: 'A',
    stage: 'tech_design',
    stageRunId: 'run-tech',
    version: 3,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:01:00.000Z'
  };

  expect(normalizeTaskProjection(previous)).toEqual({
    ...previous,
    schemaVersion: 3,
    hostMemberId: null
  });
});

test('a task accepts one host and clears that role only when the assigned host leaves', () => {
  const task = makeKanbanTaskProjection({ id: 'task-a', projectId: 'prj_a', sessionId: 'ses_a', title: 'A' });
  const hosted = assignTaskHostProjection(task, 0, 'pmem_host', '2026-07-22T00:00:01.000Z');

  expect(hosted).toMatchObject({ hostMemberId: 'pmem_host', version: 1 });
  expect(() => assignTaskHostProjection(hosted, 1, 'pmem_other', '2026-07-22T00:00:02.000Z')).toThrow(
    'Kanban task already has a host'
  );
  expect(clearTaskHostProjection(hosted, 1, 'pmem_other', '2026-07-22T00:00:03.000Z')).toEqual(hosted);
  expect(clearTaskHostProjection(hosted, 1, 'pmem_host', '2026-07-22T00:00:04.000Z')).toMatchObject({
    hostMemberId: null,
    version: 2
  });
});

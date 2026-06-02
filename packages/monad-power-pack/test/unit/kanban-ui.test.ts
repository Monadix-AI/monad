import { expect, test } from 'bun:test';

const ui = (await import('../../src/experiences/kanban.js')) as Record<string, unknown>;

const waitingTask = {
  id: 'task-product',
  projectId: 'prj_a',
  sessionId: 'ses_product',
  title: 'Plan release',
  stage: 'product_design',
  version: 0,
  displayState: 'waiting',
  host: null,
  members: [],
  documents: { product_design: null, tech_design: null },
  availableActions: { start: false, moveNext: false }
};

const assignedTask = {
  ...waitingTask,
  host: {
    member: {
      id: 'tmpl_codex',
      profileId: 'tmpl_codex',
      type: 'mesh-agent',
      displayName: 'Codex'
    },
    binding: { projectMemberId: 'tmpl_codex' }
  },
  availableActions: { start: true, moveNext: false }
};

test('creates stage nodes in lifecycle order and assigns tasks to their current stage', () => {
  const createStageNodes = ui.createStageNodes as ((tasks: unknown[]) => Array<Record<string, unknown>>) | undefined;
  const nodes = createStageNodes?.([waitingTask]) ?? [];

  expect(
    nodes.map((node) => ({ id: node.id, tasks: (node.data as { tasks?: unknown[] } | undefined)?.tasks ?? [] }))
  ).toEqual([
    { id: 'product_design', tasks: [waitingTask] },
    { id: 'tech_design', tasks: [] },
    { id: 'implementation', tasks: [] },
    { id: 'verify', tasks: [] },
    { id: 'completed', tasks: [] }
  ]);
});

test('task drops permit only the immediately adjacent forward stage', () => {
  const canDropTask = ui.canDropTask as ((source: string, destination: string) => boolean) | undefined;
  expect([
    canDropTask?.('product_design', 'tech_design'),
    canDropTask?.('product_design', 'implementation'),
    canDropTask?.('tech_design', 'product_design'),
    canDropTask?.('verify', 'completed'),
    canDropTask?.('completed', 'completed')
  ]).toEqual([true, false, false, true, false]);
});

test('member and task drags decode into distinct validated payloads', () => {
  const decodeDragPayload = ui.decodeDragPayload as ((value: string) => unknown) | undefined;

  expect([
    decodeDragPayload?.('{"kind":"member-template","templateId":"tmpl_codex"}'),
    decodeDragPayload?.('{"kind":"task","taskId":"task_a","sourceStage":"product_design"}'),
    decodeDragPayload?.('{"kind":"task","taskId":"","sourceStage":"product_design"}'),
    decodeDragPayload?.('not json')
  ]).toEqual([
    { kind: 'member-template', templateId: 'tmpl_codex' },
    { kind: 'task', taskId: 'task_a', sourceStage: 'product_design' },
    null,
    null
  ]);
});

test('member templates and session cards use a drop channel distinct from stage task moves', () => {
  expect({ member: ui.MEMBER_DRAG_MIME, task: ui.TASK_DRAG_MIME }).toEqual({
    member: 'application/x-monad-kanban-member',
    task: 'application/x-monad-kanban-task'
  });
});

test('Start eligibility requires both the server action and the unique host slot', () => {
  const canStartTask = ui.canStartTask as ((task: unknown) => boolean) | undefined;

  expect([canStartTask?.(waitingTask), canStartTask?.(assignedTask)]).toEqual([false, true]);
});

test('card members resolve their avatar, name, and provider icon from the assigned template', () => {
  const memberCardPresentation = ui.memberCardPresentation as
    | ((member: unknown, templates: unknown[]) => unknown)
    | undefined;
  const member = {
    member: { profileId: 'tmpl_codex', type: 'mesh-agent', displayName: 'Ada' },
    binding: {}
  };
  const templates = [
    {
      id: 'tmpl_codex',
      type: 'mesh-agent',
      name: 'codex',
      presentation: { avatarUrl: 'https://example.test/ada.png', provider: 'codex' }
    }
  ];

  expect(memberCardPresentation?.(member, templates)).toEqual({
    avatarUrl: 'https://example.test/ada.png',
    name: 'Ada',
    productIcon: 'codex'
  });
});

test('card document rows keep Product Design and Tech Design outputs in a stable dedicated order', () => {
  const kanbanDocumentRows = ui.kanbanDocumentRows as ((documents: unknown) => unknown) | undefined;
  const techDocument = {
    name: 'tech-design.md',
    path: '/workspace/docs/kanban/task-a/tech-design.md',
    updatedAt: '2026-07-22T00:04:00.000Z'
  };

  expect(kanbanDocumentRows?.({ product_design: null, tech_design: techDocument })).toEqual([
    { stage: 'product_design', label: 'Product Design', document: null },
    { stage: 'tech_design', label: 'Tech Design', document: techDocument }
  ]);
});

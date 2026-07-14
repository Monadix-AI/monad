import { expect, test } from 'bun:test';

import { renderBoardMarkup, renderInspectorMarkup } from '../../src/experiences/kanban.js';

const requirementsTask = {
  id: 'task-r',
  title: 'Plan release',
  stage: 'requirements',
  requirementsState: 'discussing',
  executionState: 'idle',
  version: 0,
  proposals: [],
  runs: []
};
const executionTask = {
  id: 'task-e',
  title: 'Build release',
  stage: 'execution',
  requirementsState: 'proposal_approved',
  executionState: 'running',
  version: 2,
  proposals: [],
  runs: []
};
const acceptanceTask = {
  id: 'task-a',
  title: 'Review release',
  stage: 'acceptance',
  requirementsState: 'proposal_approved',
  executionState: 'succeeded',
  version: 4,
  proposals: [],
  runs: []
};

test('kanban renders exactly the three active lanes from private task data', () => {
  const html = renderBoardMarkup([requirementsTask, executionTask, acceptanceTask]);

  expect(html).toContain('Requirements');
  expect(html).toContain('Execution');
  expect(html).toContain('Acceptance');
  expect(html).not.toContain('graphCanvas');
  expect(html.match(/class="lane"/g)).toHaveLength(3);
});

test('requirements inspector contains complete discussion and composer controls', () => {
  const html = renderInspectorMarkup(requirementsTask, {
    messages: [{ id: 'msg-a', role: 'user', text: 'Discuss A', createdAt: '2026-07-14T00:00:00.000Z' }]
  });

  expect(html).toContain('Task discussion');
  expect(html).toContain('Discuss A');
  expect(html).toContain('data-action="send-message"');
  expect(html).toContain('data-action="submit-proposal"');
});

test('execution and acceptance inspectors expose observation and review controls', () => {
  const execution = renderInspectorMarkup(executionTask, {
    observations: [{ id: 'evt-a', kind: 'tool.called', text: 'Tool calls', createdAt: '2026-07-14T00:00:00.000Z' }],
    approvals: [{ id: 'apr-a', summary: 'shell' }]
  });
  const acceptance = renderInspectorMarkup(acceptanceTask, {});

  expect(execution).toContain('Tool calls');
  expect(execution).toContain('data-action="resolve-approval"');
  expect(acceptance).toContain('data-action="accept-task"');
  expect(acceptance).toContain('data-action="return-task"');
});

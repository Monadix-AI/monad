import { expect, test } from 'bun:test';

const canvasUrl = new URL('../../src/features/studio/agent-workshop/AgentFlowCanvas.tsx', import.meta.url);
const panelUrl = new URL('../../src/features/studio/agent-workshop/AgentFlowPanel.tsx', import.meta.url);

test('agent editor renders a fixed six-node React Flow sequence', async () => {
  const source = await Bun.file(canvasUrl).text();

  expect(source).toContain("from '@xyflow/react'");
  expect(source).toContain('nodesDraggable={false}');
  expect(source).toContain('nodesConnectable={false}');
  expect(source).toContain("['request', 'identity', 'model', 'tools', 'safety', 'response']");
});

test('context panel preserves every existing agent setting group', async () => {
  const source = await Bun.file(panelUrl).text();

  for (const label of [
    'When should this agent be used?',
    'Instructions',
    'Use workspace default',
    'Use workspace capabilities',
    'Maximum turns',
    'Maximum thinking tokens',
    'Maximum budget',
    'Other Monad agents',
    'Public API',
    'A2A'
  ]) {
    expect(source).toContain(label);
  }
  expect(source).toContain('<details');
  expect(source).toContain('Advanced');
});

test('open desktop panel reserves canvas and toolbar space', async () => {
  const source = await Bun.file(
    new URL('../../src/features/studio/agent-workshop/AgentWorkshop.tsx', import.meta.url)
  ).text();

  expect(source).toContain('lg:mr-[500px]');
  expect(source).toContain('lg:right-[520px]');
});

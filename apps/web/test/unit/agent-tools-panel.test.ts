import { expect, test } from 'bun:test';

import { toggleDisabledSkill } from '#/features/studio/agent-workshop/panels/ToolsPanel';

test('skill selection updates the exact per-agent disabled instance ids', () => {
  const disabled = ['global:pdf', 'atom-pack:writing:review'];

  const enabledPdf = toggleDisabledSkill(disabled, 'global:pdf');
  expect(enabledPdf).toEqual(['atom-pack:writing:review']);

  const disabledResearch = toggleDisabledSkill(enabledPdf, 'global:research');
  expect(disabledResearch).toEqual(['atom-pack:writing:review', 'global:research']);
});

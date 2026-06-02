import type { ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { parsePlanSections } from '#/agent/context/recitation.ts';
import { AgentLoop, InMemoryMessageRepo } from '#/agent/index.ts';
import { renderPlanAnchor } from '#/agent/prompts.ts';

const SUMMARY = `## Objective
Ship the recitation anchor.

## Decisions & Facts
- Uses the existing structured summary sections.

## Files & State
- apps/monad/src/agent/context/recitation.ts: new, parses sections.

## Open Tasks
- [ ] Wire into PromptBuilder
- [ ] Add tests

## Next Step
Write the unit tests for parsePlanSections.`;

test('extracts Open Tasks and Next Step bodies, excluding the heading and later sections', () => {
  const sections = parsePlanSections(SUMMARY);
  expect(sections.openTasks).toBe('- [ ] Wire into PromptBuilder\n- [ ] Add tests');
  expect(sections.nextStep).toBe('Write the unit tests for parsePlanSections.');
});

test('a summary with neither section yields both undefined', () => {
  const sections = parsePlanSections('## Objective\nJust an objective, nothing else.');
  expect(sections).toEqual({ openTasks: undefined, nextStep: undefined });
});

test('handles Next Step as the LAST section (no trailing "## " to bound it)', () => {
  const sections = parsePlanSections('## Next Step\nDo the thing.');
  expect(sections.nextStep).toBe('Do the thing.');
});

test('an empty section (heading with nothing after it) is treated as absent, not an empty string', () => {
  const sections = parsePlanSections('## Open Tasks\n\n## Next Step\nDo X');
  expect(sections.openTasks).toBeUndefined();
});

test('renderPlanAnchor renders both sections into one <plan> block', () => {
  const anchor = renderPlanAnchor({ openTasks: '- [ ] a', nextStep: 'do b' });
  expect(anchor).toContain('<plan>');
  expect(anchor).toContain('Open tasks:');
  expect(anchor).toContain('- [ ] a');
  expect(anchor).toContain('Next step: do b');
  expect(anchor).toContain('</plan>');
});

test('renderPlanAnchor returns empty string when both sections are absent', () => {
  expect(renderPlanAnchor({})).toBe('');
});

test('renderPlanAnchor renders just the section that is present', () => {
  const anchor = renderPlanAnchor({ nextStep: 'do b' });
  expect(anchor).not.toContain('Open tasks:');
  expect(anchor).toContain('Next step: do b');
});

test('AgentLoop with recitationEnabled splices the plan anchor onto the sent prompt', async () => {
  let capturedUserText = '';
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user');
      capturedUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    recitationEnabled: true,
    history: { assemble: async () => ({ summary: SUMMARY, messages: [] }) }
  });
  await loop.runBlock(newId('ses') as never, 'what next?');
  expect(capturedUserText).toContain('<plan>');
  expect(capturedUserText).toContain('Wire into PromptBuilder');
  expect(capturedUserText).toContain('Write the unit tests for parsePlanSections.');
});

test('AgentLoop without recitationEnabled never adds a plan anchor even with a summary present', async () => {
  let capturedUserText = '';
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user');
      capturedUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    history: { assemble: async () => ({ summary: SUMMARY, messages: [] }) }
  });
  await loop.runBlock(newId('ses') as never, 'what next?');
  expect(capturedUserText).not.toContain('<plan>');
});

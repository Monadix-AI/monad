import type { LoadedSkill } from '#/agent/loop/index.ts';

import { expect, test } from 'bun:test';

import { renderAgentSystemPrompt } from '#/agent/prompts.ts';

const skill = (name: string, modelInvocable = true): LoadedSkill => ({
  name,
  body: `${name} body`,
  description: `${name} description`,
  modelInvocable
});

test('renders the complete default system prompt from one Eta template', () => {
  const output = renderAgentSystemPrompt({
    slots: {
      soul: 'SOUL CONTENT',
      agent: 'AGENT CONTENT',
      user: 'USER CONTENT',
      environment: '<environment>\ncwd: /repo\n</environment>',
      injectedContext: 'HOOK CONTEXT'
    },
    skills: [skill('visible'), skill('hidden', false)],
    toolNames: ['browser__snapshot', 'computer__take_screenshot']
  });

  expect(output).toContain('You are an interactive engineering agent.');
  expect(output).toContain('SOUL CONTENT');
  expect(output).toContain('AGENT CONTENT');
  expect(output).toContain('USER CONTENT');
  expect(output).toContain('cwd: /repo');
  expect(output).toContain('HOOK CONTEXT');
  expect(output).toContain('"skill_id":"visible"');
  expect(output).not.toContain('hidden');
  expect(output).toContain('Default to the browser');
  expect(output).toContain('real desktop by screenshot');
});

test('omits optional system sections when their data is absent', () => {
  const output = renderAgentSystemPrompt({ slots: {}, skills: [], toolNames: [] });

  expect(output).not.toContain('Available skills:');
  expect(output).not.toContain('browser__');
  expect(output).not.toContain('computer__');
});

test('renders caller-provided instructions through the complete custom-system template', () => {
  const output = renderAgentSystemPrompt({
    instructions: 'CUSTOM INSTRUCTIONS\n\n{{SOUL}}',
    slots: { soul: 'CUSTOM SOUL' },
    skills: [skill('visible')],
    toolNames: ['browser__snapshot']
  });

  expect(output).toStartWith('CUSTOM INSTRUCTIONS');
  expect(output.match(/CUSTOM SOUL/g)).toHaveLength(1);
  expect(output).toContain('"skill_id":"visible"');
  expect(output).toContain('Use the browser tools');
});

import type { LoadedSkill } from '#/agent/loop/index.ts';

import { expect, test } from 'bun:test';

import { renderAgentCredentialManifest, renderAgentSystemPrompt } from '#/agent/prompts.ts';

const skill = (name: string, modelInvocable = true): LoadedSkill => ({
  name,
  body: `${name} body`,
  description: `${name} description`,
  modelInvocable
});

test('renders the complete default system prompt from one Eta template', () => {
  const output = renderAgentSystemPrompt({
    slots: {
      agent: 'AGENT CONTENT',
      user: 'USER CONTENT',
      environment: '<environment>\ncwd: /repo\n</environment>',
      injectedContext: 'HOOK CONTEXT'
    },
    skills: [skill('visible'), skill('hidden', false)],
    toolNames: ['browser__snapshot', 'computer__take_screenshot']
  });

  expect(output).toContain('You are an interactive engineering agent.');
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
  expect(output).not.toContain('Agent Runtime Credentials');
});

test('renders the non-secret Credential manifest with ordinary environment-variable usage', () => {
  const credentials = renderAgentCredentialManifest([
    {
      label: 'Primary API',
      description: 'Read metrics',
      environmentVariable: 'PRIMARY_API_TOKEN',
      allowedHosts: ['api.example.com']
    }
  ]);
  const output = renderAgentSystemPrompt({ slots: { credentials }, skills: [], toolNames: [] });

  expect(output).toContain('## Agent Runtime Credentials');
  expect(output).toContain('$GITHUB_TOKEN');
  expect(output).toContain('"environmentVariable":"PRIMARY_API_TOKEN"');
  expect(output).toContain('"allowedHosts":["api.example.com"]');
  expect(output).not.toContain('credentialId');
  expect(output).not.toContain('configured');
});

test('renders caller-provided instructions through the complete custom-system template', () => {
  const output = renderAgentSystemPrompt({
    instructions: 'CUSTOM INSTRUCTIONS\n\n{{AGENT}}',
    slots: { agent: 'CUSTOM AGENT' },
    skills: [skill('visible')],
    toolNames: ['browser__snapshot']
  });

  expect(output).toStartWith('CUSTOM INSTRUCTIONS');
  expect(output.match(/CUSTOM AGENT/g)).toHaveLength(1);
  expect(output).toContain('"skill_id":"visible"');
  expect(output).toContain('Use the browser tools');
});

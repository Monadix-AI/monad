import { expect, test } from 'bun:test';

import {
  workplaceProjectMemberTemplateSchema,
  workplaceProjectMemberTemplatesSchema,
  workplaceProjectSessionMemberSchema
} from '../src/index.ts';

test('a member template is a preset with no runtime binding fields', () => {
  const template = workplaceProjectMemberTemplateSchema.parse({
    id: 'tpl_codex_reviewer',
    type: 'external-agent',
    name: 'codex',
    displayName: 'Code Reviewer',
    settings: { modelId: 'gpt-5-codex' }
  });
  expect(template.id).toBe('tpl_codex_reviewer');
  // Templates never carry a live binding — the schema has no externalAgentSessionId field at all.
  expect('externalAgentSessionId' in template).toBe(false);
});

test('a template catalog is just an array of templates', () => {
  const templates = workplaceProjectMemberTemplatesSchema.parse([
    { id: 'tpl_a', type: 'external-agent', name: 'codex' },
    { id: 'tpl_b', type: 'acp', name: 'claude' }
  ]);
  expect(templates).toHaveLength(2);
});

test('a session member invited from a template carries the templateId link', () => {
  const member = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_codex_a',
    templateId: 'tpl_codex_reviewer',
    type: 'external-agent',
    name: 'codex',
    displayName: 'Codex'
  });
  expect(member.templateId).toBe('tpl_codex_reviewer');
  expect(member.externalAgentSessionId).toBeUndefined();
});

test('an ad-hoc spawned session member has no templateId', () => {
  const member = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_ad_hoc',
    type: 'external-agent',
    name: 'claude'
  });
  expect(member.templateId).toBeUndefined();
});

test('a running session member carries its bound external-agent session id', () => {
  const member = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_codex_a',
    type: 'external-agent',
    name: 'codex',
    externalAgentSessionId: 'exa_01KWY0000000000000000000'
  });
  expect(member.externalAgentSessionId).toBe('exa_01KWY0000000000000000000');
});

test('a malformed external-agent session id is rejected', () => {
  expect(
    workplaceProjectSessionMemberSchema.safeParse({
      id: 'pmem_a',
      type: 'external-agent',
      name: 'codex',
      externalAgentSessionId: 'not-an-exa-id'
    }).success
  ).toBe(false);
});

test('the same template invited into two session members yields two distinct member ids', () => {
  const a = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_1',
    templateId: 'tpl_codex_reviewer',
    type: 'external-agent',
    name: 'codex',
    externalAgentSessionId: 'exa_01KWY1111111111111111111A'
  });
  const b = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_2',
    templateId: 'tpl_codex_reviewer',
    type: 'external-agent',
    name: 'codex',
    externalAgentSessionId: 'exa_01KWY2222222222222222222B'
  });
  expect(a.id).not.toBe(b.id);
  expect(a.externalAgentSessionId).not.toBe(b.externalAgentSessionId);
  expect(a.templateId).toBe(b.templateId);
});

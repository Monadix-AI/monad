import { expect, test } from 'bun:test';

import {
  workplaceProjectMemberTemplateSchema,
  workplaceProjectMemberTemplatesSchema,
  workplaceProjectSessionMemberSchema
} from '../src/index.ts';

test('a member template is a preset with no runtime binding fields', () => {
  const template = workplaceProjectMemberTemplateSchema.parse({
    id: 'tpl_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex',
    displayName: 'Code Reviewer',
    settings: { modelId: 'gpt-5-codex' }
  });
  expect(template.id).toBe('tpl_codex_reviewer');
  // Templates never carry a live binding — the schema has no meshSessionId field at all.
  expect('meshSessionId' in template).toBe(false);
});

test('a template catalog is just an array of templates', () => {
  const templates = workplaceProjectMemberTemplatesSchema.parse([
    { id: 'tpl_a', type: 'mesh-agent', name: 'codex' },
    { id: 'tpl_b', type: 'acp', name: 'claude' }
  ]);
  expect(templates).toHaveLength(2);
});

test('a session member invited from a template carries the templateId link', () => {
  const member = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_codex_a',
    templateId: 'tpl_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex',
    displayName: 'Codex',
    joinedAt: '2026-07-18T08:00:00.000Z'
  });
  expect(member).toEqual({
    id: 'pmem_codex_a',
    templateId: 'tpl_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex',
    displayName: 'Codex',
    joinedAt: '2026-07-18T08:00:00.000Z'
  });
});

test('an ad-hoc spawned session member has no templateId', () => {
  const member = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_ad_hoc',
    type: 'mesh-agent',
    name: 'claude'
  });
  expect(member.templateId).toBeUndefined();
});

test('a running session member carries its bound mesh-agent session id', () => {
  const member = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_codex_a',
    type: 'mesh-agent',
    name: 'codex',
    meshSessionId: 'mesh_01KWY0000000'
  });
  expect(member.meshSessionId).toBe('mesh_01KWY0000000');
});

test('a malformed mesh-agent session id is rejected', () => {
  expect(
    workplaceProjectSessionMemberSchema.safeParse({
      id: 'pmem_a',
      type: 'mesh-agent',
      name: 'codex',
      meshSessionId: 'not-an-exa-id'
    }).success
  ).toBe(false);
});

test('the same template invited into two session members yields two distinct member ids', () => {
  const a = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_1',
    templateId: 'tpl_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex',
    meshSessionId: 'mesh_01KWY1111111'
  });
  const b = workplaceProjectSessionMemberSchema.parse({
    id: 'pmem_2',
    templateId: 'tpl_codex_reviewer',
    type: 'mesh-agent',
    name: 'codex',
    meshSessionId: 'mesh_01KWY2222222'
  });
  expect(a.id).not.toBe(b.id);
  expect(a.meshSessionId).not.toBe(b.meshSessionId);
  expect(a.templateId).toBe(b.templateId);
});

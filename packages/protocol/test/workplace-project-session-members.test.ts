import { expect, test } from 'bun:test';

import { workplaceProjectMemberTemplateSchema, workplaceProjectMemberTemplatesSchema } from '../src/index.ts';

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

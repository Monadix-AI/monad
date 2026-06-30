import { expect, test } from 'bun:test';

import { normalizeGithubSkillSource } from '../../components/studio/SkillsSettings/utils.ts';

test('normalizeGithubSkillSource keeps GitHub tree URLs unambiguous', () => {
  expect(normalizeGithubSkillSource('https://github.com/vercel-labs/skills/tree/main/skills/find-skills')).toBe(
    'https://github.com/vercel-labs/skills/tree/main/skills/find-skills'
  );
});

test('normalizeGithubSkillSource canonicalizes repository roots and accepts shorthand', () => {
  expect(normalizeGithubSkillSource('https://github.com/vercel-labs/skills')).toBe('github:vercel-labs/skills');
  expect(normalizeGithubSkillSource('github:vercel-labs/skills@main')).toBe('github:vercel-labs/skills@main');
});

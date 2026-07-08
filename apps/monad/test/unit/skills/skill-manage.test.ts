import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillManageTool } from '#/capabilities/tools/registry/skill-manage.ts';

let dir: string;
const ctx = { sessionId: 'ses_x', log: () => {} };
const md = (name: string, body = 'B') =>
  ['---', `name: ${name}`, `description: ${name} skill.`, '---', body].join('\n');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-skillmanage-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('is high-risk so writes route through the oversight gate', () => {
  const tool = createSkillManageTool(dir);
  expect(tool.highRisk).toBe(true);
  expect(tool.name).toBe('skill_manage');
});

test('input schema enforces a known action and a name', () => {
  const tool = createSkillManageTool(dir);
  expect(tool.inputSchema?.safeParse({ action: 'nope', name: 'x' }).success).toBe(false);
  expect(tool.inputSchema?.safeParse({ action: 'create' }).success).toBe(false); // no name
  expect(tool.inputSchema?.safeParse({ action: 'create', name: 'x', content: 'c' }).success).toBe(true);
});

test('create then patch then delete a skill on disk', async () => {
  const tool = createSkillManageTool(dir);

  const created = await tool.run({ action: 'create', name: 'alpha', content: md('alpha', 'one two') }, ctx);
  expect(created.modelContent).toMatch(/saved/);

  await tool.run({ action: 'patch', name: 'alpha', oldString: 'two', newString: 'three' }, ctx);

  await tool.run({ action: 'delete', name: 'alpha' }, ctx);
  expect(await Bun.file(join(dir, 'alpha', 'SKILL.md')).exists()).toBe(false);
});

test('write_file / remove_file manage bundled resources', async () => {
  const tool = createSkillManageTool(dir);
  await tool.run({ action: 'create', name: 'docs', content: md('docs') }, ctx);
  await tool.run({ action: 'write_file', name: 'docs', file: 'references/R.md', content: '# ref' }, ctx);
  expect(await Bun.file(join(dir, 'docs', 'references', 'R.md')).text()).toBe('# ref');
  await tool.run({ action: 'remove_file', name: 'docs', file: 'references/R.md' }, ctx);
  expect(await Bun.file(join(dir, 'docs', 'references', 'R.md')).exists()).toBe(false);
});

test('surfaces per-action validation and home guards as errors', async () => {
  const tool = createSkillManageTool(dir);
  await expect(tool.run({ action: 'create', name: 'x' }, ctx)).rejects.toThrow(/requires "content"/);
  await expect(tool.run({ action: 'create', name: 'x', content: 'no frontmatter' }, ctx)).rejects.toThrow(
    /frontmatter/
  );
  await expect(tool.run({ action: 'patch', name: 'x', oldString: 'a' }, ctx)).rejects.toThrow(/requires/);
  // path traversal in a resource write is rejected by the home guard
  await tool.run({ action: 'create', name: 'safe', content: md('safe') }, ctx);
  await expect(
    tool.run({ action: 'write_file', name: 'safe', file: '../escape.md', content: 'x' }, ctx)
  ).rejects.toThrow(/escapes/);
});

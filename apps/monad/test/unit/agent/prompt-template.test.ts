import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePrompt } from '#/agent/prompt-template.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function promptFile(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'monad-prompt-'));
  roots.push(root);
  const path = join(root, 'test.prompt.md');
  await writeFile(path, source);
  return path;
}

test('renders Eta interpolation and conditionals from a prompt file', async () => {
  const sourcePath = await promptFile('Hello <%= it.name %>!<% if (it.showTools) { %> Tools: <%= it.count %>.<% } %>');
  const prompt = await definePrompt<{ name: string; showTools: boolean; count: number }>({
    id: 'test.render',
    sourcePath
  });

  expect(prompt.render({ name: 'Monad', showTools: true, count: 3 })).toBe('Hello Monad! Tools: 3.');
  expect(prompt.render({ name: 'Monad', showTools: false, count: 3 })).toBe('Hello Monad!');
  expect(prompt.id).toBe('test.render');
  expect(prompt.sourcePath).toBe(sourcePath);
  expect(prompt.sourceHash).toMatch(/^[a-f0-9]{64}$/);
});

test('rejects an empty rendered prompt', async () => {
  const sourcePath = await promptFile('<% if (it.enabled) { %>enabled<% } %>');
  const prompt = await definePrompt<{ enabled: boolean }>({ id: 'test.empty-render', sourcePath });

  expect(() => prompt.render({ enabled: false })).toThrow('rendered empty output');
});

test('rejects legacy mustache slots', async () => {
  const sourcePath = await promptFile('Hello {{NAME}}');

  await expect(definePrompt({ id: 'test.legacy-slot', sourcePath })).rejects.toThrow('legacy slot');
});

test('rejects a prompt id registered by another file', async () => {
  const firstPath = await promptFile('first');
  const secondPath = await promptFile('second');
  await definePrompt({ id: 'test.duplicate-id', sourcePath: firstPath });

  await expect(definePrompt({ id: 'test.duplicate-id', sourcePath: secondPath })).rejects.toThrow('already registered');
});

test.each([
  'include("other")',
  'layout("base")',
  'capture(() => {})',
  'await fetch("https://example.test")'
])('rejects forbidden Eta code: %s', async (code) => {
  const sourcePath = await promptFile(`<% ${code} %>prompt`);

  await expect(definePrompt({ id: `test.forbidden.${code}`, sourcePath })).rejects.toThrow('forbidden Eta code');
});

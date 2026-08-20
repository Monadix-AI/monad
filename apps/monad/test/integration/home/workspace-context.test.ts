import type { MonadPaths } from '@monad/environment';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, pathsForHome } from '@monad/environment';

import { loadWorkspacePromptSlots, WORKSPACE_CONTEXT_FILES } from '#/store/home/workspace-context.ts';

function makePaths(base: string): MonadPaths {
  return pathsForHome(base);
}

let testDir: string;
let workspace: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `monad-wsctx-${Date.now()}-${Math.trunc(performance.now())}`);
  workspace = join(testDir, 'workspace');
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test('empty workspace falls back to shipped default slots', async () => {
  const slots = await loadWorkspacePromptSlots(workspace);
  expect(slots.agent).toContain('# Workspace Instructions');
  expect(slots.user).toContain('# User');
});

test('unedited seeded files still provide default slot values', async () => {
  const paths = makePaths(testDir);
  await initMonadHome(paths);
  const slots = await loadWorkspacePromptSlots(paths.workspace);
  expect(slots.agent).toContain('# Workspace Instructions');
  expect(slots.user).toContain('# User');
});

test('injects edited AGENT.md', async () => {
  await Bun.write(join(workspace, 'AGENT.md'), 'Always write tests.');
  const slots = await loadWorkspacePromptSlots(workspace);
  expect(slots.agent).toBe('Always write tests.');
});

test('whitespace-only files fall back to defaults', async () => {
  await Bun.write(join(workspace, 'AGENT.md'), '   \n\n  ');
  expect((await loadWorkspacePromptSlots(workspace)).agent).toContain('# Workspace Instructions');
});

test('whitelist names cover AGENT.md and USER.md', () => {
  expect(WORKSPACE_CONTEXT_FILES).toEqual(['AGENT.md', 'USER.md']);
});

test('injects USER.md as part of the static core', async () => {
  await Bun.write(join(workspace, 'USER.md'), 'User deploys with Bun.');
  const slots = await loadWorkspacePromptSlots(workspace);
  expect(slots.user).toBe('User deploys with Bun.');
});

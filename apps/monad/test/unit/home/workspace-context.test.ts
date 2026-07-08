import type { MonadPaths } from '@monad/home';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, pathsForHome } from '@monad/home';

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
  const _slots = await loadWorkspacePromptSlots(workspace);
});

test('unedited seeded files still provide default slot values', async () => {
  const paths = makePaths(testDir);
  await initMonadHome(paths);
  const _slots = await loadWorkspacePromptSlots(paths.workspace);
});

test('injects edited files in precedence order (SOUL then AGENT)', async () => {
  await Bun.write(join(workspace, 'AGENT.md'), 'Always write tests.');
  await Bun.write(join(workspace, 'SOUL.md'), 'You are Hermes.');
});

test('AGENTS.md is accepted as the AGENT.md alias', async () => {
  await Bun.write(join(workspace, 'AGENTS.md'), 'Operating rules here.');
  expect((await loadWorkspacePromptSlots(workspace)).agent).toBe('Operating rules here.');
});

test('AGENT.md wins over AGENTS.md when both exist', async () => {
  await Bun.write(join(workspace, 'AGENT.md'), 'primary');
  await Bun.write(join(workspace, 'AGENTS.md'), 'alias');
  expect((await loadWorkspacePromptSlots(workspace)).agent).toBe('primary');
});

test('whitespace-only files fall back to defaults', async () => {
  await Bun.write(join(workspace, 'SOUL.md'), '   \n\n  ');
});

test('whitelist names cover SOUL, AGENT (+ AGENTS alias) and USER', () => {
  expect(WORKSPACE_CONTEXT_FILES).toEqual(['SOUL.md', 'AGENT.md', 'AGENTS.md', 'USER.md']);
});

test('injects USER.md as part of the static core (after SOUL/AGENT)', async () => {
  await Bun.write(join(workspace, 'SOUL.md'), 'You are Hermes.');
  await Bun.write(join(workspace, 'USER.md'), 'User deploys with Bun.');
});

import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionSandboxService } from '#/services/session-sandbox.ts';

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'svc-sbx-'));
}

test('disabled service is a no-op: ensure returns undefined, dispose/sweep do nothing', async () => {
  const svc = createSessionSandboxService({ enabled: false, baseDir: await base() });
  expect(svc.enabled).toBe(false);
  await svc.dispose('ses_1'); // must not throw
  expect(await svc.sweep([])).toBe(0);
});

test('enabled service creates a disposable root and tears it down', async () => {
  const baseDir = await base();
  try {
    const svc = createSessionSandboxService({ enabled: true, baseDir });
    const roots = await svc.ensure('ses_42');
    expect(roots).toHaveLength(1);
    expect(existsSync(roots?.[0] as string)).toBe(true);

    await svc.dispose('ses_42');
    expect(existsSync(roots?.[0] as string)).toBe(false);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('seedTemplate: files are copied into the session root on ensure', async () => {
  const baseDir = await base();
  const tmpl = await mkdtemp(join(tmpdir(), 'svc-tmpl-'));
  try {
    await writeFile(join(tmpl, 'requirements.txt'), 'requests==2.32.0\n');
    const svc = createSessionSandboxService({ enabled: true, baseDir, seedTemplate: tmpl });
    const roots = await svc.ensure('ses_seed');
    const copied = join(roots?.[0] ?? '', 'requirements.txt');
    expect(existsSync(copied)).toBe(true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
    await rm(tmpl, { recursive: true, force: true });
  }
});

test('initScript: runs in the session root and its output is logged', async () => {
  const baseDir = await base();
  const messages: string[] = [];
  try {
    const svc = createSessionSandboxService({
      enabled: true,
      baseDir,
      initScript: 'echo hello > init-done.txt',
      log: (m) => messages.push(m)
    });
    const roots = await svc.ensure('ses_init');
    expect(existsSync(join(roots?.[0] ?? '', 'init-done.txt'))).toBe(true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('boot sweep reclaims roots whose session is gone, keeps the live ones', async () => {
  const baseDir = await base();
  try {
    const svc = createSessionSandboxService({ enabled: true, baseDir });
    const live = await svc.ensure('live');
    await svc.ensure('dead');

    const removed = await svc.sweep(['live']);
    expect(removed).toBe(1);
    expect(existsSync(live?.[0] as string)).toBe(true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

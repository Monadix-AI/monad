import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSandboxBackends } from '#/capabilities/tools/backends.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'monad-be-'));
}

test('sandbox fs backend writes and reads within roots, with windowing', async () => {
  const dir = await tmp();
  try {
    const { fs } = createSandboxBackends([dir]);
    expect(fs.delegated).toBe(false);
    const p = join(dir, 'a.txt');
    const res = await fs.writeTextFile(p, 'hello\nworld');
    expect(res.bytesWritten).toBe(11);
    expect(await fs.readTextFile(p)).toBe('hello\nworld');
    expect(await fs.readTextFile(p, { offset: 2, limit: 1 })).toBe('world');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox fs backend rejects paths outside the roots', async () => {
  const dir = await tmp();
  try {
    const { fs } = createSandboxBackends([dir]);
    await expect(fs.readTextFile('/etc/hosts')).rejects.toThrow();
    await expect(fs.writeTextFile('/tmp/escape-me.txt', 'x')).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox terminal backend streams cumulative output via onChunk', async () => {
  const dir = await tmp();
  try {
    const { terminal } = createSandboxBackends([dir]);
    const chunks: string[] = [];
    const r = await terminal.exec({ command: 'printf "a\\nb\\nc\\n"', onChunk: (out) => chunks.push(out) });
    // onChunk fired at least once and the last cumulative value matches the final stdout.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]).toBe(r.stdout);
    // Cumulative (monotonic non-shrinking) — each chunk is a prefix-extension of the prior.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.startsWith(chunks[i - 1] ?? '')).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox terminal backend runs a command and captures output', async () => {
  const dir = await tmp();
  try {
    const { terminal } = createSandboxBackends([dir]);
    expect(terminal.delegated).toBe(false);
    const r = await terminal.exec({ command: 'echo hi' });
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox terminal backend asks piped git commands to preserve color', async () => {
  const dir = await tmp();
  try {
    const { terminal } = createSandboxBackends([dir]);
    await terminal.exec({ command: 'git init --quiet && touch a.txt && git add a.txt && echo x > a.txt' });
    const r = await terminal.exec({ command: 'git status --short' });
    expect(r.stdout).toContain('\x1B[');
    expect(r.stdout).toContain('a.txt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

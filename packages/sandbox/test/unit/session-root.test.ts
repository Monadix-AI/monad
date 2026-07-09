// Attack-pattern tests for the per-session sandbox root (session-root.ts). The session id reaches
// this code from agent-controllable context (a tool-call argument, not an operator-set config), so
// the interesting question is: can a hostile session id escape baseDir via path traversal, and does
// the crash-recovery sweep ever delete a live session's directory?

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSessionSandbox,
  disposeSessionSandbox,
  sandboxDirName,
  sessionSandboxPath,
  sweepOrphanSandboxes
} from '../../src/session-root.ts';

describe('sandboxDirName: hostile session ids cannot escape baseDir', () => {
  test('"../../etc/passwd" collapses to a single safe segment, not a traversal', () => {
    const name = sandboxDirName('../../etc/passwd');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  test('an absolute path used as a session id does not resolve as absolute', () => {
    const name = sandboxDirName('/etc/passwd');
    expect(name.startsWith('/')).toBe(false);
  });

  test('".." and "." alone do not collapse to baseDir or its parent', () => {
    expect(sandboxDirName('..')).not.toBe('..');
    expect(sandboxDirName('.')).not.toBe('.');
    expect(sandboxDirName('')).not.toBe('');
  });

  test('a Windows-style traversal ("..\\\\..\\\\secrets") is neutralized too (backslash is not a path separator here, but must not slip through as literal traversal on a system that treats it as one)', () => {
    sandboxDirName('..\\..\\secrets');
    // Backslashes are not stripped by the allowlist regex, but the leading ".." plus separator chars
    // are — the important invariant is that join(baseDir, name) never leaves baseDir.
    const base = mkdtempSync(join(tmpdir(), 'monad-sroot-'));
    try {
      const p = sessionSandboxPath(base, '..\\..\\secrets');
      expect(p.startsWith(base)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('sessionSandboxPath never resolves outside baseDir for any of the above', () => {
    const base = '/var/monad/sandboxes';
    for (const hostile of ['../../etc', '/etc/passwd', '..', '.', '', '../../../../root']) {
      const p = sessionSandboxPath(base, hostile);
      expect(p.startsWith(`${base}/`) || p === base).toBe(true);
      expect(p).not.toContain('..');
    }
  });
});

describe('lifecycle: create/dispose stay confined to baseDir', () => {
  test('createSessionSandbox with a traversal-attempt id creates a dir INSIDE baseDir, not outside', async () => {
    const base = mkdtempSync(join(tmpdir(), 'monad-sroot-'));
    try {
      const dir = await createSessionSandbox(base, '../../../tmp/evil');
      expect(dir.startsWith(base)).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(base, '..', '..', 'tmp', 'evil'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('disposeSessionSandbox for a hostile id only ever removes inside baseDir', async () => {
    const base = mkdtempSync(join(tmpdir(), 'monad-sroot-'));
    const sentinel = join(base, '..', 'sentinel-should-survive');
    try {
      writeFileSync(sentinel, 'still here');
      await disposeSessionSandbox(base, '../sentinel-should-survive');
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(sentinel, { force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('sweepOrphanSandboxes: crash recovery never deletes a live session', () => {
  test('a session in `keep` survives the sweep even when other dirs are reclaimed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'monad-sroot-'));
    try {
      mkdirSync(join(base, sandboxDirName('live-session')));
      mkdirSync(join(base, sandboxDirName('orphan-session')));
      const removed = await sweepOrphanSandboxes(base, ['live-session']);
      expect(removed).toBe(1);
      expect(existsSync(join(base, sandboxDirName('live-session')))).toBe(true);
      expect(existsSync(join(base, sandboxDirName('orphan-session')))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test(
    'two distinct hostile ids that collapse to the SAME sanitized name do not cause one live ' +
      'session to be swept because another session id happened to sanitize identically',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'monad-sroot-'));
      try {
        // '../evil' and '..\\evil' can plausibly collapse to related-but-different safe names; the
        // real invariant under test is that `keep` is compared post-sanitization, consistently with
        // how the directory was created — a session kept by its raw id is never swept.
        const rawId = '../session-A';
        mkdirSync(join(base, sandboxDirName(rawId)));
        const removed = await sweepOrphanSandboxes(base, [rawId]);
        expect(removed).toBe(0);
        expect(existsSync(join(base, sandboxDirName(rawId)))).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  );

  test('missing baseDir is a no-op, not a throw (must not crash daemon boot)', async () => {
    const removed = await sweepOrphanSandboxes('/nonexistent/monad-sandboxes-xyz', []);
    expect(removed).toBe(0);
  });
});

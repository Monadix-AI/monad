import { describe, expect, test } from 'bun:test';

import { buildAppContainerArgs, win32AppContainerLauncher } from '../../src/sandbox/win32-appcontainer.ts';

// buildAppContainerArgs is the pure arg-building function (no binary lookup).
// win32AppContainerLauncher metadata tests don't need a binary on PATH.

function args(policy: Parameters<typeof buildAppContainerArgs>[1], cmd = ['cmd.exe']): string[] {
  return buildAppContainerArgs(cmd, policy);
}

// ── profileName (tested through args()) ──────────────────────────────────────

function profileNameFrom(a: string[]): string {
  const idx = a.indexOf('--profile');
  expect(idx).toBeGreaterThanOrEqual(0);
  return a[idx + 1] ?? '';
}

describe('profile name encoding', () => {
  test('hyphens stripped from session id', () => {
    const a = args({ sessionId: 'ses_abc-123-def', writableRoots: [], net: 'none' });
    const name = profileNameFrom(a);
    expect(name).toMatch(/^monad\./);
    expect(name).not.toContain('-');
  });

  test('profile name is at most 64 characters', () => {
    const a = args({ sessionId: `ses_${'a'.repeat(100)}`, writableRoots: [], net: 'none' });
    const name = profileNameFrom(a);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  test('profile name starts with monad.', () => {
    const a = args({ sessionId: 'ses_deadbeef0123', writableRoots: [], net: 'none' });
    const name = profileNameFrom(a);
    expect(name).toMatch(/^monad\./);
  });

  test('no sessionId → no --profile flag', () => {
    const a = args({ writableRoots: [], net: 'none' });
    expect(a).not.toContain('--profile');
  });
});

// ── arg structure ─────────────────────────────────────────────────────────────

describe('arg structure', () => {
  test('always ends with -- <cmd>', () => {
    const a = args({ writableRoots: [], net: 'none' }, ['node.exe', 'script.js']);
    const sep = a.indexOf('--');
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(a[sep + 1]).toBe('node.exe');
    expect(a[sep + 2]).toBe('script.js');
  });

  test('net:none → no --net-client', () => {
    const a = args({ writableRoots: [], net: 'none' });
    expect(a).not.toContain('--net-client');
  });

  test('net:filtered → --net-client', () => {
    const a = args({ writableRoots: [], net: { allowProxyPort: 12345 } });
    expect(a).toContain('--net-client');
  });

  test('net:unrestricted → --net-client', () => {
    const a = args({ writableRoots: [], net: 'unrestricted' });
    expect(a).toContain('--net-client');
  });

  test('writableRoots → one --writable per path', () => {
    const a = args({ writableRoots: ['C:\\work\\session', 'C:\\tmp'], net: 'none' });
    expect(a.filter((v) => v === '--writable').length).toBe(2);
    expect(a).toContain('C:\\work\\session');
    expect(a).toContain('C:\\tmp');
  });

  test('readDenyRoots → one --deny-read per path', () => {
    const a = args({ writableRoots: [], readDenyRoots: ['C:\\Users\\u\\.ssh', 'C:\\Users\\u\\.aws'], net: 'none' });
    expect(a.filter((v) => v === '--deny-read').length).toBe(2);
    expect(a).toContain('C:\\Users\\u\\.ssh');
    expect(a).toContain('C:\\Users\\u\\.aws');
  });
});

// ── launcher metadata ─────────────────────────────────────────────────────────

test('kind is appcontainer', () => {
  expect(win32AppContainerLauncher.kind).toBe('appcontainer');
});

test('platforms is win32 only', () => {
  expect(win32AppContainerLauncher.platforms).toEqual(['win32']);
});

test('enforces writeConfine + readDeny + net none', () => {
  expect(win32AppContainerLauncher.enforces).toMatchObject({
    writeConfine: true,
    readDeny: true,
    net: expect.arrayContaining(['none'])
  });
});

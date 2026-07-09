import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolvePlaywrightDaemonPort, resolvePlaywrightWebPort } from '../../playwright.config.ts';

test('resolvePlaywrightWebPort prefers explicit WEB_PORT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'WEB_PORT=3729\n');

  try {
    expect(resolvePlaywrightWebPort({ WEB_PORT: '3333' }, envPath)).toBe(3333);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightWebPort reuses repo env WEB_PORT when explicit WEB_PORT is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'MONAD_PORT=52749\nWEB_PORT=3729\n');

  try {
    expect(resolvePlaywrightWebPort({}, envPath)).toBe(3729);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightDaemonPort reuses repo env MONAD_PORT when explicit MONAD_PORT is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'MONAD_PORT=52522\nWEB_PORT=3729\n');

  try {
    expect(resolvePlaywrightDaemonPort({}, envPath)).toBe(52522);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightDaemonPort prefers explicit MONAD_PORT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-pw-port-'));
  const envPath = join(dir, '.env.local');
  writeFileSync(envPath, 'MONAD_PORT=52522\n');

  try {
    expect(resolvePlaywrightDaemonPort({ MONAD_PORT: '52666' }, envPath)).toBe(52666);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePlaywrightWebPort falls back to the Playwright default', () => {
  expect(resolvePlaywrightWebPort({}, '/no/such/env.local')).toBe(3201);
});

if (process.platform === 'win32') process.exit(0);

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureTlsCert, findOpenssl } from '../../src/tls.ts';

let tlsDir: string;

beforeEach(() => {
  tlsDir = join(tmpdir(), `monad-tls-test-${Date.now()}`);
});

afterEach(async () => {
  await Bun.$`rm -rf ${tlsDir}`.quiet().nothrow();
});

test('ensureTlsCert sets key.pem to mode 0o600 (owner-read only)', async () => {
  const openssl = await findOpenssl();
  if (!openssl) return; // skip when openssl is not installed

  const { keyPath } = await ensureTlsCert(tlsDir);
  const { mode } = await stat(keyPath);
  expect(mode & 0o777).toBe(0o600);
});

test('ensureTlsCert is idempotent: reuses existing cert files', async () => {
  const openssl = await findOpenssl();
  if (!openssl) return;

  const first = await ensureTlsCert(tlsDir);
  const { mtimeMs: mtime1 } = await stat(first.certPath);

  await Bun.sleep(10);
  const second = await ensureTlsCert(tlsDir);
  const { mtimeMs: mtime2 } = await stat(second.certPath);

  expect(mtime1).toBe(mtime2);
  expect(first.certPath).toBe(second.certPath);
});

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDestroySoon, readDaemonEndpoint } from '../../vite.config.ts';

test('readDaemonEndpoint prefers repo env MONAD_PORT over config network port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-vite-config-'));
  const envPath = join(dir, '.env.local');
  const monadHome = join(dir, 'home');
  mkdirSync(join(monadHome, 'configs'), { recursive: true });
  writeFileSync(envPath, `MONAD_HOME=${monadHome}\nMONAD_PORT=52522\n`);
  writeFileSync(
    join(monadHome, 'configs', 'config.json'),
    JSON.stringify({
      network: {
        https: { enabled: true },
        port: 52749
      }
    })
  );

  try {
    expect(readDaemonEndpoint({}, envPath)).toEqual({ port: '52522', scheme: 'https' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDaemonEndpoint preserves config scheme when env supplies only the port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-vite-config-'));
  const envPath = join(dir, '.env.local');
  const monadHome = join(dir, 'home');
  mkdirSync(join(monadHome, 'configs'), { recursive: true });
  writeFileSync(envPath, `MONAD_HOME=${monadHome}\nMONAD_PORT=52522\n`);
  writeFileSync(
    join(monadHome, 'configs', 'config.json'),
    JSON.stringify({
      network: {
        https: { enabled: false },
        port: 52749
      }
    })
  );

  try {
    expect(readDaemonEndpoint({}, envPath)).toEqual({ port: '52522', scheme: 'http' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDestroySoon adds node-compatible close helper for Bun websocket proxy sockets', () => {
  const calls: string[] = [];
  const socket: { destroy(): void; destroySoon?: () => void; end(): void } = {
    destroy() {
      calls.push('destroy');
    },
    end() {
      calls.push('end');
    }
  };

  ensureDestroySoon(socket);
  if (!socket.destroySoon) throw new Error('destroySoon was not installed');
  socket.destroySoon();

  expect(calls).toEqual(['end', 'destroy']);
});

test('ensureDestroySoon does not replace an existing socket helper', () => {
  const existing = () => {};
  const socket = {
    destroy() {},
    destroySoon: existing,
    end() {}
  };

  ensureDestroySoon(socket);

  expect(socket.destroySoon).toBe(existing);
});

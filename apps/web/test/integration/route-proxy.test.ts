import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readDaemonUrl uses configured HTTPS from mesh config', () => {
  const home = join(tmpdir(), `monad-route-proxy-${Date.now()}`);
  mkdirSync(join(home, 'configs'), { recursive: true });
  writeFileSync(
    join(home, 'configs', 'mesh.json'),
    JSON.stringify({
      network: {
        port: 52522,
        https: { enabled: true, certStrategy: 'self-signed' },
        remoteAccess: { enabled: true, token: 'secret' }
      }
    })
  );

  const env: Record<string, string | undefined> = { ...process.env, MONAD_HOME: home, MONAD_PORT: '52522' };
  delete env.MONAD_URL;
  const moduleUrl = new URL('../../server/index.ts', import.meta.url).href;

  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `const { readDaemonUrl } = await import(${JSON.stringify(moduleUrl)}); console.log(readDaemonUrl());`
      ],
      env,
      stderr: 'pipe',
      stdout: 'pipe'
    });
    expect({
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString().trim()
    }).toEqual({ exitCode: 0, stderr: '', stdout: 'https://127.0.0.1:52522' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

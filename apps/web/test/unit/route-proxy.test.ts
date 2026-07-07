import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDaemonUrl } from '../../app/api/[...path]/route.proxy.ts';

test('readDaemonUrl uses HTTPS by default from network config', () => {
  const home = join(tmpdir(), `monad-route-proxy-${Date.now()}`);
  mkdirSync(join(home, 'configs'), { recursive: true });
  writeFileSync(
    join(home, 'configs', 'config.json'),
    JSON.stringify({
      network: {
        port: 52522,
        https: { enabled: true, certStrategy: 'self-signed' },
        remoteAccess: { enabled: true, token: 'secret' }
      }
    })
  );

  const prevHome = process.env.MONAD_HOME;
  const prevPort = process.env.MONAD_PORT;
  process.env.MONAD_HOME = home;
  process.env.MONAD_PORT = '52522';

  try {
    expect(readDaemonUrl()).toBe('https://127.0.0.1:52522');
  } finally {
    process.env.MONAD_HOME = prevHome;
    process.env.MONAD_PORT = prevPort;
    rmSync(home, { recursive: true, force: true });
  }
});

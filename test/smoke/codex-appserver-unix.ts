// biome-ignore-all lint/suspicious/noConsole: standalone smoke CLI — console is the report
// Smoke test: drive a real `codex app-server --listen unix://…` through the actual launch builder,
// the hand-rolled unix WebSocket transport, and the codex adapter, asserting the initialize→thread
// handshake yields a provider session ref. Requires a local codex binary; exits 0 (skipped) when
// codex is absent.  run: bun test/smoke/codex-appserver-unix.ts
import type { NativeCliRuntimeHandle } from '../../apps/monad/src/services/native-cli/types.ts';

import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectAppServerUnix } from '../../apps/monad/src/services/native-cli/app-server-unix.ts';
import {
  buildNativeCliLaunch,
  registerAgentAdapterImpl,
  resolveNativeCliLaunchCommand
} from '../../apps/monad/src/services/native-cli/index.ts';
import { codexNativeCliAdapter } from '../../packages/atoms/src/agent-adapters/codex/index.ts';

registerAgentAdapterImpl(codexNativeCliAdapter);

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const preset = codexNativeCliAdapter.detect();
if (!preset.installed) {
  console.log('SKIP: codex not installed');
  process.exit(0);
}

const agent = {
  name: 'codex',
  provider: 'codex' as const,
  command: 'codex',
  enabled: true,
  defaultLaunchMode: 'app-server' as const,
  allowDangerousMode: false,
  approvalOwnership: 'provider-owned' as const
};

const dir = join(realpathSync(tmpdir()), 'monad-appserver');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const socketPath = join(dir, `smoke-${process.pid}.sock`);
rmSync(socketPath, { force: true });

const launch = resolveNativeCliLaunchCommand(
  codexNativeCliAdapter,
  buildNativeCliLaunch(agent, {
    workingPath: process.cwd(),
    launchMode: 'app-server',
    appServerTransport: 'unix',
    appServerSocketPath: socketPath
  })
);

if (!launch.argv.includes(`unix://${socketPath}`))
  fail(`unix launch argv missing socket url: ${launch.argv.join(' ')}`);
console.log('launch argv:', launch.argv.join(' '));

const proc = Bun.spawn(launch.argv, {
  cwd: launch.cwd,
  env: process.env,
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore'
});

let requestSeq = 0;
let sessionRef: string | undefined;
const handle: NativeCliRuntimeHandle = {
  launchMode: 'app-server',
  providerSessionRef: null,
  pendingRequests: new Map(),
  nextRequestId: () => requestSeq++,
  kill: () => proc.kill('SIGTERM')
};

const gotRef = new Promise<void>((resolve) => {
  void (async () => {
    const connection = await connectAppServerUnix({
      socketPath,
      onMessage: (text) => {
        for (const event of codexNativeCliAdapter.parseOutput(`${text}\n`, handle)) {
          if (event.type === 'session_ref' && typeof event.payload.providerSessionRef === 'string') {
            sessionRef = event.payload.providerSessionRef;
            handle.providerSessionRef = sessionRef;
            resolve();
          }
        }
      },
      onClose: () => {},
      timeoutMs: 10_000
    });
    handle.appServer = connection;
    codexNativeCliAdapter.initialize?.(handle, { workingPath: process.cwd() });
  })().catch((error) => fail(`unix connect failed: ${String(error)}`));
});

await Promise.race([gotRef, Bun.sleep(12_000)]);
proc.kill('SIGKILL');
rmSync(socketPath, { force: true });

if (!sessionRef) fail('no provider session ref received over unix transport');
console.log(`PASS: unix transport handshake produced session ref ${sessionRef}`);
process.exit(0);

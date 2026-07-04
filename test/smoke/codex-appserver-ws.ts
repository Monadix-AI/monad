/// <reference types="bun" />
// biome-ignore-all lint/suspicious/noConsole: standalone smoke CLI — console is the report
// Smoke test: drive a real `codex app-server --listen ws://…` through the actual launch builder,
// ws transport helper, and codex adapter, asserting the initialize→thread handshake yields a
// provider session ref. Requires a local codex binary; exits 0 (skipped) when codex is absent.
//   run: bun test/smoke/codex-appserver-ws.ts

import type { NativeCliRuntimeHandle } from '../../apps/monad/src/services/native-cli/types.ts';

import { connectAppServerWs } from '../../apps/monad/src/services/native-cli/app-server-ws.ts';
import {
  buildNativeCliLaunch,
  registerAgentAdapterImpl,
  resolveNativeCliLaunchCommand
} from '../../apps/monad/src/services/native-cli/index.ts';
import { codexNativeCliAdapter } from '../../packages/atoms/src/agent-adapters/codex/index.ts';

// The launch builder resolves adapters from the daemon's runtime registry; register codex here since
// this smoke drives the pipeline outside a booted daemon.
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

const launch = resolveNativeCliLaunchCommand(
  codexNativeCliAdapter,
  buildNativeCliLaunch(agent, { workingPath: process.cwd(), launchMode: 'app-server', appServerTransport: 'ws' })
);

if (!launch.argv.includes('--listen') || !launch.argv.some((a) => a.startsWith('ws://'))) {
  fail(`ws launch argv missing listen url: ${launch.argv.join(' ')}`);
}
console.log('launch argv:', launch.argv.join(' '));

const proc = Bun.spawn(launch.argv, {
  cwd: launch.cwd,
  env: process.env,
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe'
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
    const connection = await connectAppServerWs({
      stderr: proc.stderr,
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
  })().catch((error) => fail(`ws connect failed: ${String(error)}`));
});

await Promise.race([gotRef, Bun.sleep(12_000)]);
proc.kill('SIGTERM');
await proc.exited;

if (!sessionRef) fail('no provider session ref received over ws transport');
console.log(`PASS: ws transport handshake produced session ref ${sessionRef}`);
process.exit(0);

/// <reference types="bun" />
// biome-ignore-all lint/suspicious/noConsole: standalone smoke CLI — console is the report
// Smoke test: drive a real codex app-server turn end-to-end — send a long-running turn, wait for it
// to go in-flight, interrupt it, and assert the turn settles. This exercises the turn lifecycle
// (turn/started tracking), turn/interrupt, and turn/completed against the real binary — the handshake
// smokes cover only initialize→thread. Requires a local codex signed in enough to *start* a turn;
// exits 0 (skipped) when codex is absent or can't run a turn (auth/quota).
//   run: bun test/smoke/codex-appserver-turn.ts
import type {
  ExternalAgentOutputEvent,
  ExternalAgentRuntimeHandle
} from '../../apps/monad/src/services/external-agent/types.ts';

import { connectAppServerWs } from '../../apps/monad/src/services/external-agent/app-server-ws.ts';
import {
  buildExternalAgentLaunch,
  registerAgentAdapterImpl,
  resolveExternalAgentLaunchCommand
} from '../../apps/monad/src/services/external-agent/index.ts';
import { codexExternalAgentAdapter } from '../../packages/atoms/src/agent-adapters/codex/index.ts';

registerAgentAdapterImpl(codexExternalAgentAdapter);

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
function skip(message: string): never {
  console.log(`SKIP: ${message}`);
  process.exit(0);
}
const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(100);
  }
  return predicate();
};

if (!codexExternalAgentAdapter.detect().installed) skip('codex not installed');

const launch = resolveExternalAgentLaunchCommand(
  codexExternalAgentAdapter,
  buildExternalAgentLaunch(
    {
      name: 'codex',
      provider: 'codex',
      command: 'codex',
      enabled: true,
      defaultLaunchMode: 'app-server',
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    },
    { workingPath: process.cwd(), launchMode: 'app-server', appServerTransport: 'ws' }
  )
);

const proc = Bun.spawn(launch.argv, {
  cwd: launch.cwd,
  env: process.env,
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe'
});
const cleanup = (): void => {
  proc.kill('SIGKILL');
};

let requestSeq = 0;
let ready = false;
let failure: ExternalAgentOutputEvent | undefined;
const handle: ExternalAgentRuntimeHandle = {
  launchMode: 'app-server',
  providerSessionRef: null,
  pendingRequests: new Map(),
  nextRequestId: () => requestSeq++,
  kill: cleanup
};

void (async () => {
  const connection = await connectAppServerWs({
    stderr: proc.stderr,
    onMessage: (text) => {
      for (const event of codexExternalAgentAdapter.parseOutput(`${text}\n`, handle)) {
        if (event.type === 'session_ref' && typeof event.payload.providerSessionRef === 'string' && !ready) {
          handle.providerSessionRef = event.payload.providerSessionRef;
          ready = true;
        }
        if (event.type === 'provider_error' || event.type === 'connection_required') failure = event;
      }
    },
    onClose: () => {},
    timeoutMs: 10_000
  });
  handle.appServer = connection;
  codexExternalAgentAdapter.initialize?.(handle, { workingPath: process.cwd() });
})().catch((error) => fail(`ws connect failed: ${String(error)}`));

if (!(await until(() => ready, 12_000))) {
  cleanup();
  fail('handshake did not produce a provider session ref');
}

// Send a slow, long-running turn so there is a window to interrupt it.
codexExternalAgentAdapter.sendInput(handle, 'Count slowly from 1 to 40, one number per line, pausing between each.');

// The turn either goes in-flight (turn/started sets currentTurnId) or errors out (auth/quota).
const inFlight = await until(() => handle.currentTurnId !== undefined || failure !== undefined, 20_000);
if (failure) {
  cleanup();
  skip(`codex could not run a turn (${String(failure.payload.code ?? failure.type)})`);
}
if (!inFlight || handle.currentTurnId === undefined) {
  cleanup();
  fail('turn never went in-flight (no turn/started)');
}
console.log(`turn in-flight: ${handle.currentTurnId}`);

// Interrupt it and assert the turn settles (currentTurnId cleared on turn/completed).
codexExternalAgentAdapter.interrupt?.(handle);
const settled = await until(() => handle.currentTurnId === undefined, 15_000);
cleanup();
await proc.exited;

if (!settled) fail('interrupt did not settle the in-flight turn');
console.log('PASS: real codex turn went in-flight and interrupt settled it');
process.exit(0);

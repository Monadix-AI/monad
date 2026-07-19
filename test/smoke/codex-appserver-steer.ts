// biome-ignore-all lint/suspicious/noConsole: standalone smoke CLI — console is the report
// Smoke test: steer a real codex app-server turn mid-flight. Send a long-running turn, wait for it to
// go in-flight, inject a `turn/steer`, assert the turn survives the steer (still in-flight — steer
// amends the turn, it does not end it, unlike interrupt), then interrupt to settle it. Complements
// codex-appserver-turn.ts (which covers interrupt). Requires a local codex signed in enough to *start*
// a turn; exits 0 (skipped) when codex is absent or can't run a turn (auth/quota).
//   run: bun test/smoke/codex-appserver-steer.ts
import type { MeshAgentOutputEvent, MeshAgentRuntimeHandle } from '../../apps/monad/src/services/mesh-agent/types.ts';

import { connectAppServerWs } from '../../apps/monad/src/services/mesh-agent/app-server-ws.ts';
import {
  buildMeshAgentLaunch,
  registerAgentAdapterImpl,
  resolveMeshAgentLaunchCommand
} from '../../apps/monad/src/services/mesh-agent/index.ts';
import { codexMeshAgentAdapter } from '../../packages/atoms/src/agent-adapters/codex/index.ts';
import { codexRuntimeState } from '../../packages/atoms/src/agent-adapters/codex/state.ts';

registerAgentAdapterImpl(codexMeshAgentAdapter);

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
const holds = async (predicate: () => boolean, forMs: number): Promise<boolean> => {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    if (!predicate()) return false;
    await Bun.sleep(100);
  }
  return predicate();
};

if (!codexMeshAgentAdapter.detect().installed) skip('codex not installed');

const launch = resolveMeshAgentLaunchCommand(
  codexMeshAgentAdapter,
  buildMeshAgentLaunch(
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
let failure: MeshAgentOutputEvent | undefined;
const getFailure = (): MeshAgentOutputEvent | undefined => failure;
const handle: MeshAgentRuntimeHandle = {
  launchMode: 'app-server',
  providerSessionRef: null,
  pendingRequests: new Map(),
  nextRequestId: () => requestSeq++,
  kill: cleanup
};
const runtimeState = codexRuntimeState(handle);

void (async () => {
  const connection = await connectAppServerWs({
    stderr: proc.stderr,
    onMessage: (text) => {
      for (const event of codexMeshAgentAdapter.parseOutput(`${text}\n`, handle)) {
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
  codexMeshAgentAdapter.initialize?.(handle, { workingPath: process.cwd() });
})().catch((error) => fail(`ws connect failed: ${String(error)}`));

if (!(await until(() => ready, 12_000))) {
  cleanup();
  fail('handshake did not produce a provider session ref');
}

// Send a slow, long-running turn so there is a window to steer it.
codexMeshAgentAdapter.sendInput(handle, 'Count slowly from 1 to 60, one number per line, pausing between each.');

const inFlight = await until(() => runtimeState.currentTurnId !== undefined || failure !== undefined, 20_000);
if (failure) {
  cleanup();
  skip(`codex could not run a turn (${String(failure.payload.code ?? failure.type)})`);
}
if (!inFlight || runtimeState.currentTurnId === undefined) {
  cleanup();
  fail('turn never went in-flight (no turn/started)');
}
const steeredTurn = runtimeState.currentTurnId;
console.log(`turn in-flight: ${steeredTurn}`);

// Steer the in-flight turn. Unlike interrupt, steer amends the turn — it must NOT end it.
codexMeshAgentAdapter.steer?.(handle, 'Also, after each number, write its square.');

// The same turn stays in flight through the steer (no early settle, no connection-killing error).
const survived = await holds(() => runtimeState.currentTurnId === steeredTurn && failure === undefined, 3_000);
if (!survived) {
  cleanup();
  const failureAtCheck = getFailure();
  if (failureAtCheck) fail(`steer produced an error: ${String(failureAtCheck.payload.code ?? failureAtCheck.type)}`);
  fail('steer ended the turn (currentTurnId changed/cleared) — steer must amend, not terminate');
}
console.log('turn survived steer, still in-flight');

// Clean up: interrupt settles the steered turn.
codexMeshAgentAdapter.interrupt?.(handle);
const settled = await until(() => runtimeState.currentTurnId === undefined, 15_000);
cleanup();
await proc.exited;

if (!settled) fail('interrupt did not settle the steered turn');
console.log('PASS: real codex turn accepted steer mid-flight and interrupt settled it');
process.exit(0);

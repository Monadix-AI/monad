import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import {
  archiveOpenClawSession,
  deleteOpenClawSession,
  unarchiveOpenClawSession
} from '../../src/agent-adapters/openclaw/lifecycle.ts';

const port = 43123;
const token = 'lifecycle-token';

function bytes(contents = ''): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (contents) controller.enqueue(new TextEncoder().encode(contents));
      controller.close();
    }
  });
}

function context(): MeshAgentProviderSessionLifecycleContext {
  return {
    meshSessionId: 'mesh_lifecycle',
    transcriptTargetId: 'ses_lifecycle',
    agentName: 'pmem_agent',
    agent: {
      name: 'pmem_agent',
      provider: 'openclaw',
      productIcon: 'openclaw',
      command: 'openclaw-custom',
      args: ['--profile', 'work'],
      enabled: true,
      allowAutopilot: false,
      approvalOwnership: 'provider-owned'
    },
    providerSessionRef: 'agent:work:target',
    workingPath: '/tmp/project'
  };
}

const gatewayArgv = [
  'openclaw-custom',
  '--profile',
  'work',
  'gateway',
  'run',
  '--allow-unconfigured',
  '--bind',
  'loopback',
  '--auth',
  'token',
  '--port',
  String(port),
  '--ws-log',
  'compact'
];

function callArgv(method: string, params: Record<string, unknown>): string[] {
  return [
    'openclaw-custom',
    '--profile',
    'work',
    'gateway',
    'call',
    '--json',
    '--url',
    `ws://127.0.0.1:${port}`,
    '--token',
    token,
    '--params',
    JSON.stringify(params),
    method
  ];
}

test('OpenClaw lifecycle starts a loopback gateway and applies provider mutations through its exact URL', async () => {
  const calls: string[][] = [];
  let stoppedGateways = 0;
  const spawn = (argv: string[]) => {
    calls.push(argv);
    if (argv.includes('run')) {
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      return {
        exited,
        stdout: bytes('[gateway] ready\n'),
        stderr: bytes(),
        kill: () => {
          stoppedGateways += 1;
          resolveExit(0);
        }
      };
    }
    return { exited: Promise.resolve(0), stdout: bytes('{}\n'), stderr: bytes(), kill: () => {} };
  };
  const options = { port, spawn, token };

  await archiveOpenClawSession(context(), options);
  await unarchiveOpenClawSession(context(), options);
  await deleteOpenClawSession(context(), options);

  expect(calls).toEqual([
    gatewayArgv,
    callArgv('sessions.patch', { key: 'agent:work:target', archived: true }),
    gatewayArgv,
    callArgv('sessions.patch', { key: 'agent:work:target', archived: false }),
    gatewayArgv,
    callArgv('sessions.patch', { key: 'agent:work:target', archived: true }),
    callArgv('sessions.delete', { key: 'agent:work:target', archivedOnly: true, deleteTranscript: true })
  ]);
  expect(stoppedGateways).toBe(3);
});

test('OpenClaw lifecycle stops its temporary gateway when a provider mutation fails', async () => {
  let stopped = false;
  const spawn = (argv: string[]) => {
    if (argv.includes('run')) {
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      return {
        exited,
        stdout: bytes('[gateway] ready\n'),
        stderr: bytes(),
        kill: () => {
          stopped = true;
          resolveExit(0);
        }
      };
    }
    return {
      exited: Promise.resolve(1),
      stdout: bytes(),
      stderr: bytes('provider rejected session mutation'),
      kill: () => {}
    };
  };

  await expect(deleteOpenClawSession(context(), { port, spawn, token })).rejects.toThrow(
    'openclaw gateway call sessions.patch failed: provider rejected session mutation'
  );
  expect(stopped).toBe(true);
});

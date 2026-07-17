import type { ExternalAgentLaunchSpec } from '#/services/external-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  type ExternalAgentProbeResult,
  externalAgentProbeKey,
  runExternalAgentProbeBatch
} from '#/services/external-agent/probe-batch.ts';

function launch(command: string): ExternalAgentLaunchSpec {
  return {
    argv: [command, '--help'],
    cwd: '/tmp',
    env: { PROFILE: 'test' },
    launchMode: 'pty',
    provider: 'codex',
    approvalOwnership: 'provider-owned',
    capabilities: []
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test('starts unique probes concurrently and deduplicates equal launches within one batch', async () => {
  const launchA = launch('tool-a');
  const launchB = launch('tool-b');
  const resultA = deferred<ExternalAgentProbeResult>();
  const resultB = deferred<ExternalAgentProbeResult>();
  const started: string[][] = [];

  const pending = runExternalAgentProbeBatch([launchA, launchA, launchB], (spec) => {
    started.push(spec.argv);
    return spec.argv[0] === 'tool-a' ? resultA.promise : resultB.promise;
  });

  await Promise.resolve();
  expect(started).toEqual([
    ['tool-a', '--help'],
    ['tool-b', '--help']
  ]);

  resultA.resolve({ stdout: 'a', stderr: '', exitCode: 0 });
  resultB.resolve({ stdout: 'b', stderr: 'warning', exitCode: 0 });

  expect(await pending).toEqual(
    new Map([
      [externalAgentProbeKey(launchA), { stdout: 'a', stderr: '', exitCode: 0 }],
      [externalAgentProbeKey(launchB), { stdout: 'b', stderr: 'warning', exitCode: 0 }]
    ])
  );
});

test('does not retain probe results across batch invocations', async () => {
  const spec = launch('tool-a');
  const started: string[][] = [];
  const runner = async (value: ExternalAgentLaunchSpec): Promise<ExternalAgentProbeResult> => {
    started.push(value.argv);
    return { stdout: String(started.length), stderr: '', exitCode: 0 };
  };

  const first = await runExternalAgentProbeBatch([spec], runner);
  const second = await runExternalAgentProbeBatch([spec], runner);

  expect(first).toEqual(new Map([[externalAgentProbeKey(spec), { stdout: '1', stderr: '', exitCode: 0 }]]));
  expect(second).toEqual(new Map([[externalAgentProbeKey(spec), { stdout: '2', stderr: '', exitCode: 0 }]]));
  expect(started).toEqual([
    ['tool-a', '--help'],
    ['tool-a', '--help']
  ]);
});

test('keeps the event loop responsive while a probe is pending', async () => {
  const result = deferred<ExternalAgentProbeResult>();
  const pending = runExternalAgentProbeBatch([launch('slow-tool')], () => result.promise);
  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);

  await Bun.sleep(1);
  expect(timerFired).toBe(true);

  result.resolve({ stdout: '', stderr: '', exitCode: 0 });
  await pending;
});

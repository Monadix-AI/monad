import type { MeshAgentLaunchSpec } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import {
  type MeshAgentProbeResult,
  meshAgentProbeKey,
  runMeshAgentProbeBatch
} from '#/services/mesh-agent/probe-batch.ts';

function launch(command: string): MeshAgentLaunchSpec {
  return {
    argv: [command, '--help'],
    cwd: '/tmp',
    env: { PROFILE: 'test' }
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
  const resultA = deferred<MeshAgentProbeResult>();
  const resultB = deferred<MeshAgentProbeResult>();
  const started: string[][] = [];

  const pending = runMeshAgentProbeBatch([launchA, launchA, launchB], (spec) => {
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
      [meshAgentProbeKey(launchA), { stdout: 'a', stderr: '', exitCode: 0 }],
      [meshAgentProbeKey(launchB), { stdout: 'b', stderr: 'warning', exitCode: 0 }]
    ])
  );
});

test('does not retain probe results across batch invocations', async () => {
  const spec = launch('tool-a');
  const started: string[][] = [];
  const runner = async (value: MeshAgentLaunchSpec): Promise<MeshAgentProbeResult> => {
    started.push(value.argv);
    return { stdout: String(started.length), stderr: '', exitCode: 0 };
  };

  const first = await runMeshAgentProbeBatch([spec], runner);
  const second = await runMeshAgentProbeBatch([spec], runner);

  expect(first).toEqual(new Map([[meshAgentProbeKey(spec), { stdout: '1', stderr: '', exitCode: 0 }]]));
  expect(second).toEqual(new Map([[meshAgentProbeKey(spec), { stdout: '2', stderr: '', exitCode: 0 }]]));
  expect(started).toEqual([
    ['tool-a', '--help'],
    ['tool-a', '--help']
  ]);
});

test('keeps the event loop responsive while a probe is pending', async () => {
  const result = deferred<MeshAgentProbeResult>();
  const pending = runMeshAgentProbeBatch([launch('slow-tool')], () => result.promise);
  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);

  await Bun.sleep(1);
  expect(timerFired).toBe(true);

  result.resolve({ stdout: '', stderr: '', exitCode: 0 });
  await pending;
});

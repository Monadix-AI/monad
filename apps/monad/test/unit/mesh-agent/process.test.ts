import { expect, test } from 'bun:test';

import { killMeshAgentProcess } from '#/services/mesh-agent/process.ts';

test('Windows process-tree termination uses taskkill without also signalling the leader', () => {
  const calls: string[] = [];
  killMeshAgentProcess(
    42,
    'SIGTERM',
    () => calls.push('leader'),
    'win32',
    () => calls.push('tree')
  );
  expect(calls).toEqual(['tree']);
});

test('Windows process-tree termination falls back to the leader when taskkill fails', () => {
  const calls: string[] = [];
  killMeshAgentProcess(
    42,
    'SIGTERM',
    () => calls.push('leader'),
    'win32',
    () => {
      calls.push('tree');
      throw new Error('taskkill unavailable');
    }
  );
  expect(calls).toEqual(['tree', 'leader']);
});

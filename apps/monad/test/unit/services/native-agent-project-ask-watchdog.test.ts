import { expect, test } from 'bun:test';

import { createNativeAgentProjectAskWatchdog } from '#/services/native-agent/project-ask-watchdog.ts';

test('required ask watchdog interrupts first and stops only after the second grace window', async () => {
  const callbacks: Array<() => void> = [];
  const actions: string[] = [];
  let active = true;
  const watchdog = createNativeAgentProjectAskWatchdog({
    gateMatches: () => true,
    isTurnActive: () => active,
    interrupt: () => actions.push('interrupt'),
    stop: () => actions.push('stop'),
    schedule: (callback) => {
      callbacks.push(callback);
      return {} as ReturnType<typeof setTimeout>;
    }
  });

  watchdog.arm({
    requestId: 'ask_watchdog0001',
    projectId: 'prj_watchdog0001',
    projectSessionId: 'ses_watchdog0001',
    memberInstanceId: 'builder',
    meshSessionId: 'mesh_watchdog001'
  });
  callbacks.shift()?.();
  expect(actions).toEqual(['interrupt']);
  expect(callbacks).toHaveLength(1);

  active = false;
  callbacks.shift()?.();
  expect(actions).toEqual(['interrupt']);

  active = true;
  watchdog.arm({
    requestId: 'ask_watchdog0002',
    projectId: 'prj_watchdog0001',
    projectSessionId: 'ses_watchdog0001',
    memberInstanceId: 'builder',
    meshSessionId: 'mesh_watchdog001'
  });
  callbacks.shift()?.();
  callbacks.shift()?.();
  expect(actions).toEqual(['interrupt', 'interrupt', 'stop']);
});

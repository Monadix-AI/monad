import { expect, test } from 'bun:test';

import {
  activateSessionUiInstance,
  pruneSessionUiInstances
} from '../../src/features/session/session-ui-instance-cache.ts';

test('session UI cache keeps the 20 most recently activated instances', () => {
  let entries: Array<{ key: string; sessionId: string; value: number }> = [];

  for (let index = 1; index <= 21; index += 1) {
    entries = activateSessionUiInstance(entries, {
      key: `chat:ses_${index}`,
      sessionId: `ses_${index}`,
      value: index
    });
  }

  expect(entries.map((entry) => entry.key)).toEqual(Array.from({ length: 20 }, (_, index) => `chat:ses_${21 - index}`));
});

test('session UI cache refreshes only the explicitly activated instance', () => {
  const initial = [
    { key: 'chat:ses_b', sessionId: 'ses_b', value: 2 },
    { key: 'chat:ses_a', sessionId: 'ses_a', value: 1 }
  ];
  const entries = activateSessionUiInstance(initial, { key: 'chat:ses_a', sessionId: 'ses_a', value: 3 });

  expect(entries).toEqual([
    { key: 'chat:ses_a', sessionId: 'ses_a', value: 3 },
    { key: 'chat:ses_b', sessionId: 'ses_b', value: 2 }
  ]);
});

test('session UI cache removes archived or deleted sessions', () => {
  const entries = pruneSessionUiInstances(
    [
      { key: 'chat:ses_chat', sessionId: 'ses_chat', value: 1 },
      {
        key: 'project:prj_one:session:ses_project',
        sessionId: 'ses_project',
        value: 2
      }
    ],
    new Set(['ses_project'])
  );

  expect(entries).toEqual([
    {
      key: 'project:prj_one:session:ses_project',
      sessionId: 'ses_project',
      value: 2
    }
  ]);
});

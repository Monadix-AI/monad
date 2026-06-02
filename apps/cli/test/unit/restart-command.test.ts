import { expect, test } from 'bun:test';

import { restartDaemon } from '../../src/commands/restart.ts';

const messages = {
  failed: 'Monad restart failed',
  restarted: 'Monad restarted',
  restarting: 'Restarting Monad…'
};

test('restart owns presentation and succeeds only after silent stop and ready start', async () => {
  const events: string[] = [];

  await restartDaemon({
    messages,
    start: async (options) => {
      events.push(`start:${options.silent}:${options.requireReady}`);
      return { alreadyRunning: false };
    },
    status: (message) => {
      events.push(`status:${message}`);
      return {
        fail: (finalMessage) => events.push(`fail:${finalMessage}`),
        success: (finalMessage) => events.push(`success:${finalMessage}`)
      };
    },
    stop: async (options) => {
      events.push(`stop:${options.silent}`);
    }
  });

  expect(events).toEqual(['status:Restarting Monad…', 'stop:true', 'start:true:true', 'success:Monad restarted']);
});

test('restart finalizes failure and preserves the original error', async () => {
  const events: string[] = [];
  let thrown: unknown;

  try {
    await restartDaemon({
      messages,
      start: async () => ({ alreadyRunning: false }),
      status: () => ({
        fail: (finalMessage) => events.push(`fail:${finalMessage}`),
        success: (finalMessage) => events.push(`success:${finalMessage}`)
      }),
      stop: async () => {
        throw new Error('shutdown failed');
      }
    });
  } catch (error) {
    thrown = error;
  }

  expect({ events, message: thrown instanceof Error ? thrown.message : null }).toEqual({
    events: ['fail:Monad restart failed'],
    message: 'shutdown failed'
  });
});

import type { Event, SessionId } from '@monad/protocol';
import type { CommandContext } from '../../src/commands/types.ts';

import { afterEach, expect, test } from 'bun:test';

import { command as watch } from '../../src/commands/session/watch.ts';
import { setOutputMode } from '../../src/lib/output.ts';

const sessionId = 'ses_100000000000' as SessionId;

function event(id: string, eventSessionId: SessionId, type: Event['type']): Event {
  return {
    id,
    sessionId: eventSessionId,
    type,
    actorAgentId: null,
    payload: {},
    at: '2026-07-19T00:00:00.000Z'
  } as Event;
}

afterEach(() => {
  setOutputMode({ format: 'human', color: false });
});

test('session watch filters the client-lifetime control stream and disposes on SIGINT', async () => {
  let handler: ((event: Event) => void) | undefined;
  let disposals = 0;
  let subscribed = false;
  const client = {
    subscribeControl(onEvent: (event: Event) => void) {
      subscribed = true;
      handler = onEvent;
      return () => {
        disposals++;
      };
    }
  };
  const context: CommandContext = {
    positionals: [sessionId],
    flags: {},
    globals: { json: true, quiet: false, verbose: 0, yes: false, color: false },
    client: client as CommandContext['client']
  };
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((value: string | Uint8Array) => {
    lines.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  setOutputMode({ format: 'json', color: false });

  try {
    const running = watch.run(context);
    await Promise.resolve();
    expect(subscribed).toBe(true);

    handler?.(event('evt_100000000001', 'ses_200000000000' as SessionId, 'session.run.started'));
    const created = event('evt_100000000002', sessionId, 'session.message.created');
    const started = event('evt_100000000003', sessionId, 'session.run.started');
    const completed = event('evt_100000000004', sessionId, 'session.run.completed');
    handler?.(created);
    handler?.(started);
    handler?.(completed);
    process.emit('SIGINT');
    await running;

    expect(lines.map((line) => JSON.parse(line))).toEqual([created, started, completed]);
    expect(disposals).toBe(1);
  } finally {
    process.stdout.write = originalWrite;
  }
});

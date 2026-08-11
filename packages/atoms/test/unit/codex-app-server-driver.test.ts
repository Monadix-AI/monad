import type { MeshAgentEventSink, SessionEventPacket } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { CodexAppServerDriver } from '../../src/agent-adapters/codex/app-server/driver.ts';

function packet(line: string): SessionEventPacket {
  return { bytes: new TextEncoder().encode(`${line}\n`), source: 'stdout', receivedAt: new Date().toISOString() };
}

function collectingSink(): MeshAgentEventSink {
  return { emit: async () => {} } as MeshAgentEventSink;
}

test('Codex app-server disposal handles a pending response before channel send settles', async () => {
  let finishSend!: () => void;
  const sendPending = new Promise<void>((resolve) => {
    finishSend = resolve;
  });
  const driver = new CodexAppServerDriver({ workingPath: '/tmp/project' });
  const opening = driver.attachChannel(
    {
      send: () => sendPending,
      close: async () => {}
    },
    {}
  );
  const openingError = opening.then(
    () => undefined,
    (error: unknown) => error
  );

  await driver.dispose();
  finishSend();
  const error = await openingError;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('expected channel opening to reject');
  expect(error.message).toBe('Codex app-server closed');
});

test('Codex app-server routes a broken-pipe protocol reply into the in-flight request', async () => {
  const unhandled: unknown[] = [];
  const track = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', track);
  const sent: string[] = [];
  let pipeBroken = false;
  const driver = new CodexAppServerDriver({ workingPath: '/tmp/project' });
  const opening = driver.attachChannel(
    {
      async send(frame) {
        if (pipeBroken) throw new Error('EPIPE: broken pipe, write');
        sent.push(String(frame));
      },
      close: async () => {}
    },
    {}
  );
  const openingError = opening.then(
    () => undefined,
    (error: unknown) => error
  );

  const initialize = JSON.parse(sent[0] as string) as { id: number };
  await driver.accept(packet(JSON.stringify({ id: initialize.id, result: {} })), collectingSink());
  // The child dies once the handshake landed, so the reply below writes into a dead pipe.
  pipeBroken = true;
  // A server-initiated request nobody awaits: the driver answers it method-not-found on its own.
  await driver.accept(packet(JSON.stringify({ id: 9001, method: 'tool/requestUserInput' })), collectingSink());

  const error = await openingError;
  process.off('unhandledRejection', track);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('expected channel opening to reject');
  expect(error.message).toBe('EPIPE: broken pipe, write');
  expect(unhandled).toEqual([]);
});

test('Codex app-server short-circuits later writes once the channel failed', async () => {
  const attempts: string[] = [];
  let pipeBroken = false;
  const driver = new CodexAppServerDriver({ workingPath: '/tmp/project' });
  const opening = driver.attachChannel(
    {
      async send(frame) {
        attempts.push(String(frame));
        if (pipeBroken) throw new Error('EPIPE: broken pipe, write');
      },
      close: async () => {}
    },
    {}
  );
  void opening.catch(() => undefined);
  const initialize = JSON.parse(attempts[0] as string) as { id: number };
  await driver.accept(packet(JSON.stringify({ id: initialize.id, result: {} })), collectingSink());
  pipeBroken = true;
  await driver.accept(packet(JSON.stringify({ id: 9001, method: 'tool/requestUserInput' })), collectingSink());
  await opening.catch(() => undefined);
  const afterFailure = attempts.length;

  await expect(driver.sendTurn({ text: 'hello', attachments: [] })).rejects.toThrow('EPIPE: broken pipe, write');
  expect(attempts.length).toBe(afterFailure);
});

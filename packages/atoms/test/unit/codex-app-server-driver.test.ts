import { expect, test } from 'bun:test';

import { CodexAppServerDriver } from '../../src/agent-adapters/codex/app-server/driver.ts';

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

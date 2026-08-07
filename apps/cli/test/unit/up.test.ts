import { expect, test } from 'bun:test';

import { runUp } from '../../src/lib/up.ts';

test('up resolves and opens the configured Web UI URL after daemon startup', async () => {
  const events: string[] = [];
  const opened: string[] = [];
  const written: string[] = [];

  const url = await runUp(
    { noOpen: false, nodeEnv: 'production', webPort: '3000' },
    {
      startDaemon: async () => events.push('started'),
      resolveClientConn: async () => {
        events.push('resolved');
        return { baseUrl: 'http://127.0.0.1:52749' };
      },
      openUrl: (value) => {
        events.push('opened');
        opened.push(value);
        return true;
      },
      write: (value) => written.push(value)
    }
  );

  expect({ events, opened, written, url }).toEqual({
    events: ['started', 'resolved', 'opened'],
    opened: ['http://127.0.0.1:52749'],
    written: ['Monad — http://127.0.0.1:52749\n'],
    url: 'http://127.0.0.1:52749'
  });
});

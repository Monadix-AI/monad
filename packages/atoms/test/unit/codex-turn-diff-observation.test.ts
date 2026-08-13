import { expect, test } from 'bun:test';

import { codexAppServerRecordEvents } from '../../src/agent-adapters/codex/observation/observation-app-server-notification.ts';

test('cumulative Codex turn diffs stay out of the public observation event stream', () => {
  const records = [
    { method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId: 'turn-1', diff: '--- a\n+++ b\n' } },
    {
      method: 'turn/diff/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n' }
    }
  ];

  expect(records.flatMap((record, index) => codexAppServerRecordEvents('live-epoch', record, index))).toEqual([]);
});

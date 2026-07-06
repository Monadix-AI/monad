import { expect, test } from 'bun:test';

import {
  drainProjectFollowUpQueue,
  submitProjectFollowUp
} from '../../src/workspace-experiences/chat-room/components/composer/follow-up-queue.ts';

test('submitProjectFollowUp queues text while project members are still typing', () => {
  expect(submitProjectFollowUp({ attachments: [], busy: true, queue: [], text: 'second request' })).toEqual({
    nextQueue: [{ attachments: [], text: 'second request' }],
    sendNow: null
  });
});

test('submitProjectFollowUp sends immediately when every project member has ended turn', () => {
  expect(submitProjectFollowUp({ attachments: [], busy: false, queue: [], text: 'new request' })).toEqual({
    nextQueue: [],
    sendNow: { attachments: [], text: 'new request' }
  });
});

test('drainProjectFollowUpQueue waits until project busy transitions to idle', () => {
  const queue = [
    { attachments: [], text: 'first queued' },
    { attachments: [], text: 'second queued' }
  ];
  expect(drainProjectFollowUpQueue({ busy: true, queue, wasBusy: true })).toEqual({
    nextQueue: queue,
    sendNow: null
  });
  expect(drainProjectFollowUpQueue({ busy: false, queue, wasBusy: true })).toEqual({
    nextQueue: [],
    sendNow: { attachments: [], text: 'first queued\n\nsecond queued' }
  });
});

import { expect, test } from 'bun:test';

import {
  drainProjectFollowUpQueue,
  queuedProjectFollowUpsForDisplay,
  submitProjectFollowUp
} from '../../src/workspace-experiences/chat-room/components/composer/follow-up-queue.ts';

test('submitProjectFollowUp queues text while project members are still typing', () => {
  expect(
    submitProjectFollowUp({ attachments: [], busy: true, followUpBehavior: 'queue', queue: [], text: 'second request' })
  ).toEqual({
    nextQueue: [{ attachments: [], text: 'second request' }],
    sendNow: null
  });
});

test('submitProjectFollowUp sends immediately while busy when follow-ups steer', () => {
  expect(
    submitProjectFollowUp({ attachments: [], busy: true, followUpBehavior: 'steer', queue: [], text: 'second request' })
  ).toEqual({
    nextQueue: [],
    sendNow: { attachments: [], text: 'second request' }
  });
});

test('submitProjectFollowUp sends immediately when every project member has ended turn', () => {
  expect(
    submitProjectFollowUp({ attachments: [], busy: false, followUpBehavior: 'queue', queue: [], text: 'new request' })
  ).toEqual({
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

test('queuedProjectFollowUpsForDisplay exposes newest items with original queue indexes', () => {
  expect(queuedProjectFollowUpsForDisplay(['first', 'second', 'third'])).toEqual([
    { displayIndex: 0, queueIndex: 2, text: 'third' },
    { displayIndex: 1, queueIndex: 1, text: 'second' }
  ]);
});

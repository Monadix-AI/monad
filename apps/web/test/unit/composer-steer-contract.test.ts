import { expect, test } from 'bun:test';

import { steerSendMessageRequest } from '../../src/hooks/use-chat-composer.ts';

test('single steer follow-up is sent as text steer request', () => {
  expect(steerSendMessageRequest('ses_123456789012', ['adjust'])).toEqual({
    sessionId: 'ses_123456789012',
    steer: true,
    text: 'adjust'
  });
});

test('queued steer follow-ups are sent as one ordered batch', () => {
  expect(steerSendMessageRequest('ses_123456789012', ['first adjustment', 'second adjustment'])).toEqual({
    sessionId: 'ses_123456789012',
    steer: true,
    steerMessages: ['first adjustment', 'second adjustment'],
    text: ''
  });
});

test('empty steer follow-ups are rejected before mutation construction', () => {
  expect(() => steerSendMessageRequest('ses_123456789012', [])).toThrow('steer requires at least one follow-up');
});

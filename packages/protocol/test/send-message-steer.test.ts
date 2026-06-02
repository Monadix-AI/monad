import { expect, test } from 'bun:test';

import { sendMessageRequestSchema } from '../src';

test('send message accepts an explicit steer delivery mode', () => {
  expect(sendMessageRequestSchema.parse({ text: 'adjust', steer: true })).toEqual({ text: 'adjust', steer: true });
});

test('send message accepts one ordered steer batch', () => {
  expect(
    sendMessageRequestSchema.parse({ text: '', steer: true, steerMessages: ['first adjustment', 'second adjustment'] })
  ).toEqual({ text: '', steer: true, steerMessages: ['first adjustment', 'second adjustment'] });
});

import { expect, test } from 'bun:test';

import {
  httpErrorSchema,
  publicErrorCodeSchema,
  publicErrorDescriptorSchema,
  publicErrorDetailsSchema,
  publicErrorMessageSchema,
  publicErrorRequestIdSchema
} from '../src/index.ts';

const requestId = 'req_1234567890ab';

test('public error descriptor parses the exact canonical contract', () => {
  expect(
    publicErrorDescriptorSchema.parse({
      code: 'BAD_GATEWAY',
      message: 'The upstream service is unavailable.',
      retryable: true,
      requestId,
      details: { provider: 'openrouter', attempts: 2, delayed: true, retryAfterMs: [100, 250], cause: null }
    })
  ).toEqual({
    code: 'BAD_GATEWAY',
    message: 'The upstream service is unavailable.',
    retryable: true,
    requestId,
    details: { provider: 'openrouter', attempts: 2, delayed: true, retryAfterMs: [100, 250], cause: null }
  });
});

test('public error descriptor is strict and requires canonical metadata', () => {
  expect(
    publicErrorDescriptorSchema.safeParse({ code: 'NOT_FOUND', message: 'Not found.', retryable: false, requestId })
      .success
  ).toBe(true);
  expect(publicErrorDescriptorSchema.safeParse({ code: 'NOT_FOUND', message: 'Not found.', requestId }).success).toBe(
    false
  );
  expect(
    publicErrorDescriptorSchema.safeParse({
      code: 'NOT_FOUND',
      message: 'Not found.',
      retryable: false,
      requestId,
      internal: 'stack'
    }).success
  ).toBe(false);
});

test('public error scalar fields enforce their bounds', () => {
  expect(publicErrorCodeSchema.safeParse('A').success).toBe(true);
  expect(publicErrorCodeSchema.safeParse(`A${'0'.repeat(63)}`).success).toBe(true);
  expect(publicErrorCodeSchema.safeParse('').success).toBe(false);
  expect(publicErrorCodeSchema.safeParse(`A${'0'.repeat(64)}`).success).toBe(false);
  expect(publicErrorCodeSchema.safeParse('bad_gateway').success).toBe(false);
  expect(publicErrorCodeSchema.safeParse('1_BAD').success).toBe(false);

  expect(publicErrorMessageSchema.safeParse('x').success).toBe(true);
  expect(publicErrorMessageSchema.safeParse('x'.repeat(2048)).success).toBe(true);
  expect(publicErrorMessageSchema.safeParse('').success).toBe(false);
  expect(publicErrorMessageSchema.safeParse('x'.repeat(2049)).success).toBe(false);

  expect(publicErrorRequestIdSchema.safeParse(requestId).success).toBe(true);
  expect(publicErrorRequestIdSchema.safeParse('idem_1234567890ab').success).toBe(false);
  expect(publicErrorRequestIdSchema.safeParse('req_too-short').success).toBe(false);
});

test('public error details stay shallow, bounded, and JSON-safe', () => {
  const sixteenKeys = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}`, index]));
  expect(publicErrorDetailsSchema.safeParse(sixteenKeys).success).toBe(true);
  expect(publicErrorDetailsSchema.safeParse({ ['k'.repeat(64)]: 'x'.repeat(512) }).success).toBe(true);
  expect(publicErrorDetailsSchema.safeParse({ values: Array.from({ length: 16 }, (_, index) => index) }).success).toBe(
    true
  );

  expect(publicErrorDetailsSchema.safeParse({ ...sixteenKeys, overflow: true }).success).toBe(false);
  expect(publicErrorDetailsSchema.safeParse({ ['k'.repeat(65)]: 'value' }).success).toBe(false);
  expect(publicErrorDetailsSchema.safeParse({ message: 'x'.repeat(513) }).success).toBe(false);
  expect(publicErrorDetailsSchema.safeParse({ values: Array.from({ length: 17 }, (_, index) => index) }).success).toBe(
    false
  );
  expect(publicErrorDetailsSchema.safeParse({ nested: { secret: true } }).success).toBe(false);
  expect(publicErrorDetailsSchema.safeParse({ missing: undefined }).success).toBe(false);
});

test('HTTP error schema preserves the historical shape and accepts additive metadata', () => {
  expect(httpErrorSchema.parse({ error: 'not found', code: 'NOT_FOUND' })).toEqual({
    error: 'not found',
    code: 'NOT_FOUND'
  });
  expect(
    httpErrorSchema.parse({
      error: 'upstream unavailable',
      code: 'BAD_GATEWAY',
      retryable: true,
      requestId,
      details: { provider: 'openrouter' }
    })
  ).toEqual({
    error: 'upstream unavailable',
    code: 'BAD_GATEWAY',
    retryable: true,
    requestId,
    details: { provider: 'openrouter' }
  });
});

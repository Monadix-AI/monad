import { expect, test } from 'bun:test';

import { extractError } from '#/agent/loop/index.ts';

// Simulate AI_APICallError shape from @ai-sdk/provider-utils
function apiCallError(opts: { statusCode: number; data: unknown; message?: string }): Error {
  const err = new Error(opts.message ?? `API error ${opts.statusCode}`) as Error & {
    statusCode: number;
    data: unknown;
  };
  err.statusCode = opts.statusCode;
  err.data = opts.data;
  return err;
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

test('OpenRouter: extracts metadata.raw + provider_name', () => {
  const err = apiCallError({
    statusCode: 429,
    data: {
      error: {
        message: 'Provider returned error',
        code: 429,
        metadata: {
          raw: 'google/gemma-4-26b is temporarily rate-limited. Please retry shortly.',
          provider_name: 'Google AI Studio'
        }
      }
    }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('429');
  expect(message).toBe('[Google AI Studio] google/gemma-4-26b is temporarily rate-limited. Please retry shortly.');
});

test('OpenRouter: no provider_name — uses raw only', () => {
  const err = apiCallError({
    statusCode: 500,
    data: { error: { message: 'Provider returned error', metadata: { raw: 'upstream failure' } } }
  });
  const { message } = extractError(err);
  expect(message).toBe('upstream failure');
});

// ── Anthropic ───────────────────────────────────────────────────────────────

test('Anthropic: extracts error.type as code + error.message', () => {
  const err = apiCallError({
    statusCode: 529,
    data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('overloaded_error');
  expect(message).toBe('Overloaded');
});

test('Anthropic: rate_limit_error', () => {
  const err = apiCallError({
    statusCode: 429,
    data: {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded, please retry after 1 minute.' }
    }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('rate_limit_error');
  expect(message).toBe('Rate limit exceeded, please retry after 1 minute.');
});

// ── Google ──────────────────────────────────────────────────────────────────

test('Google: extracts error.status as code + error.message', () => {
  const err = apiCallError({
    statusCode: 429,
    data: { error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED' } }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('RESOURCE_EXHAUSTED');
  expect(message).toBe('Resource has been exhausted.');
});

test('Google: no status — falls back to httpCode', () => {
  const err = apiCallError({
    statusCode: 400,
    data: { error: { code: 400, message: 'Invalid argument.' } }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('400');
  expect(message).toBe('Invalid argument.');
});

// ── OpenAI / OpenAI-compatible ───────────────────────────────────────────────

test('OpenAI: extracts error.code as semantic code + error.message', () => {
  const err = apiCallError({
    statusCode: 429,
    data: {
      error: { message: 'Rate limit reached for model `gpt-4o`.', type: 'requests', code: 'rate_limit_exceeded' }
    }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('rate_limit_exceeded');
  expect(message).toBe('Rate limit reached for model `gpt-4o`.');
});

test('OpenAI: no code — uses error.type', () => {
  const err = apiCallError({
    statusCode: 401,
    data: { error: { message: 'Invalid API key.', type: 'invalid_request_error' } }
  });
  const { code, message } = extractError(err);
  expect(code).toBe('invalid_request_error');
  expect(message).toBe('Invalid API key.');
});

// ── AggregateError (gateway) ─────────────────────────────────────────────────

test('AggregateError: unwraps to first sub-error', () => {
  const sub = apiCallError({
    statusCode: 429,
    data: { error: { message: 'Rate limit.', type: 'requests', code: 'rate_limit_exceeded' } }
  });
  const err = new AggregateError([sub], 'gateway: all model attempts failed');
  const { code, message } = extractError(err);
  expect(code).toBe('rate_limit_exceeded');
  expect(message).toBe('Rate limit.');
});

test('AggregateError with no sub-errors: uses aggregate message', () => {
  const err = new AggregateError([], 'gateway: all model attempts failed');
  const { message } = extractError(err);
  expect(message).toBe('gateway: all model attempts failed');
});

// ── Fallbacks ────────────────────────────────────────────────────────────────

test('plain Error with no structured data: uses err.message + httpCode', () => {
  const err = Object.assign(new Error('connection refused'), { statusCode: 503 });
  const { code, message } = extractError(err);
  expect(code).toBe('503');
  expect(message).toBe('connection refused');
});

test('non-Error value: stringified', () => {
  const { code, message } = extractError('something broke');
  expect(message).toBe('something broke');
});

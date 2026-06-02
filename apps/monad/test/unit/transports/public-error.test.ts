import { describe, expect, test } from 'bun:test';
import { publicErrorDescriptorSchema } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { HostInteractionError } from '#/interactions/service.ts';
import { EventCursorError } from '#/services/event-cursor.ts';
import {
  consumeRequestCorrelationId,
  createRequestCorrelationId,
  getRequestCorrelationId,
  mapPublicError,
  projectDirectHttpErrorResponse,
  projectHttpError
} from '#/transports/public-error.ts';

const requestId = 'req_000000000000' as const;

describe('public HTTP error projection', () => {
  test.each([
    ['invalid', 400, 'CURSOR_INVALID', 'event cursor is invalid'],
    ['wrong_scope', 409, 'CURSOR_WRONG_SCOPE', 'event cursor has the wrong scope'],
    ['expired', 410, 'CURSOR_EXPIRED', 'event cursor has expired']
  ] as const)('preserves cursor error %s through public projection', (reason, status, code, message) => {
    expect(mapPublicError(new EventCursorError(reason), requestId)).toEqual({
      status,
      descriptor: { code, message, retryable: false, requestId }
    });
  });

  test('maps HandlerError status, stable code, and retryability exactly', () => {
    expect(mapPublicError(new HandlerError('conflict', 'already exists', 'PROJECT_MISMATCH'), requestId)).toEqual({
      status: 409,
      descriptor: {
        code: 'PROJECT_MISMATCH',
        message: 'already exists',
        retryable: false,
        requestId
      }
    });
  });

  test('falls back from an invalid internal code to the mapped public code', () => {
    expect(mapPublicError(new HandlerError('conflict', 'already exists', 'custom_lowercase'), requestId)).toEqual({
      status: 409,
      descriptor: { code: 'CONFLICT', message: 'already exists', retryable: false, requestId }
    });
  });

  test.each([
    [
      'invalid',
      'agent_credential_not_found',
      { credentialId: 'cred_missing00000' },
      400,
      'AGENT_CREDENTIAL_NOT_FOUND',
      { credentialId: 'cred_missing00000' }
    ],
    [
      'invalid',
      'agent_credential_environment_variable_conflict',
      { environmentVariable: 'SHARED_TOKEN' },
      400,
      'AGENT_CREDENTIAL_ENVIRONMENT_VARIABLE_CONFLICT',
      { environmentVariable: 'SHARED_TOKEN' }
    ]
  ] as const)(
    'projects allowlisted structured HandlerError %s without exposing arbitrary params',
    (kind, code, params, status, publicCode, details) => {
      expect(mapPublicError(new HandlerError(kind, code, code, params), requestId)).toEqual({
        status,
        descriptor: { code: publicCode, message: code, retryable: false, requestId, details }
      });
    }
  );

  test('redacts invalid HandlerError messages that may contain rejected values or local paths', () => {
    const result = mapPublicError(
      new HandlerError('invalid', 'workingPath /Users/test/private rejected value=secret'),
      requestId
    );
    expect(result).toEqual({
      status: 400,
      descriptor: {
        code: 'VALIDATION',
        message: 'request validation failed',
        retryable: false,
        requestId,
        details: { issues: ['request validation failed'] }
      }
    });
    expect(JSON.stringify(result)).not.toContain('/Users/test/private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test.each([
    ['not_found', 'NOT_FOUND', 404, false],
    ['invalid_submission', 'VALIDATION', 400, false],
    ['invalid_lease', 'FORBIDDEN', 403, false],
    ['source_limit', 'RATE_LIMITED', 429, true],
    ['presenter_not_preferred', 'CONFLICT', 409, false],
    ['incompatible_presenter', 'CONFLICT', 409, false],
    ['already_claimed', 'CONFLICT', 409, false],
    ['unsafe_pattern', 'CONFLICT', 409, false]
  ] as const)('normalizes HostInteractionError %s', (internalCode, code, status, retryable) => {
    expect(mapPublicError(new HostInteractionError(internalCode, 'safe message'), requestId)).toEqual({
      status,
      descriptor: { code, message: 'safe message', retryable, requestId }
    });
  });

  test('redacts bad gateway upstream content and marks it retryable', () => {
    const result = mapPublicError(
      new HandlerError('bad_gateway', 'upstream token=secret raw response', 'BAD_GATEWAY'),
      requestId
    );
    expect(result).toEqual({
      status: 502,
      descriptor: {
        code: 'BAD_GATEWAY',
        message: 'upstream service unavailable',
        retryable: true,
        requestId
      }
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('redacts internal and unknown failures', () => {
    const expected = {
      status: 500,
      descriptor: { code: 'INTERNAL', message: 'internal server error', retryable: false, requestId }
    };
    expect(mapPublicError(new HandlerError('internal', 'database password secret'), requestId)).toEqual(expected);
    expect(mapPublicError(new Error('stack secret'), requestId)).toEqual(expected);
  });

  test('normalizes empty and blank public messages instead of throwing inside the error mapper', () => {
    expect(mapPublicError(new HandlerError('conflict', ''), requestId)).toEqual({
      status: 409,
      descriptor: { code: 'CONFLICT', message: 'request failed', retryable: false, requestId }
    });
    expect(mapPublicError(new HostInteractionError('already_claimed', '   '), requestId)).toEqual({
      status: 409,
      descriptor: { code: 'CONFLICT', message: 'request failed', retryable: false, requestId }
    });
  });

  test('maps validation failures without exposing rejected values', () => {
    const result = mapPublicError(new Error('value super-secret rejected'), requestId, 'VALIDATION');
    expect(result).toEqual({
      status: 400,
      descriptor: {
        code: 'VALIDATION',
        message: 'request validation failed',
        retryable: false,
        requestId,
        details: { issues: ['request validation failed'] }
      }
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  test('generates bounded distinct correlation IDs and preserves one through projection', () => {
    const first = createRequestCorrelationId();
    const second = createRequestCorrelationId();
    expect(first).toMatch(/^req_[0-9a-zA-Z]{12}$/);
    expect(second).not.toBe(first);

    const descriptor = mapPublicError(new HandlerError('not_found', 'missing'), first).descriptor;
    expect(publicErrorDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(projectHttpError(descriptor)).toEqual({
      error: 'missing',
      code: 'NOT_FOUND',
      retryable: false,
      requestId: first
    });
  });

  test('keeps one request correlation ID until the lifecycle consumes it', () => {
    const request = new Request('http://localhost/v1/test');
    const first = getRequestCorrelationId(request);
    expect(getRequestCorrelationId(request)).toBe(first);
    expect(consumeRequestCorrelationId(request)).toBe(first);
    const afterConsume = getRequestCorrelationId(request);
    expect(afterConsume).toMatch(/^req_[0-9a-zA-Z]{12}$/);
    expect(afterConsume).not.toBe(first);
  });

  test.each([
    [403, 'FORBIDDEN', 'forbidden', false],
    [401, 'UNAUTHORIZED', 'unauthorized', false],
    [429, 'RATE_LIMITED', 'too many requests', true]
  ] as const)(
    'projects a direct %i guard failure with canonical correlation',
    async (status, code, message, retryable) => {
      const request = new Request('http://localhost/v1/test');
      const response = projectDirectHttpErrorResponse(request, status, code, message, retryable);
      const requestId = response.headers.get('x-monad-request-id');
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: message, code, retryable, requestId });
      expect(requestId).toBe(getRequestCorrelationId(request));
    }
  );

  test('preserves guard headers and bounded numeric retry details', async () => {
    const request = new Request('http://localhost/v1/test');
    const response = projectDirectHttpErrorResponse(
      request,
      429,
      'RATE_LIMITED',
      'too many requests',
      true,
      { retryAfterSeconds: 2 },
      { 'retry-after': '2' }
    );
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({
      error: 'too many requests',
      code: 'RATE_LIMITED',
      retryable: true,
      requestId: response.headers.get('x-monad-request-id'),
      details: { retryAfterSeconds: 2 }
    });
  });
});

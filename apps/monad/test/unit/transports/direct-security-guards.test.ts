import { expect, test } from 'bun:test';

import { streamBrowserGuardResponse } from '#/transports/http/stream/controller.ts';
import { systemRemoteGuardResponse } from '#/transports/http/system.ts';
import {
  browserGuardErrorResponse,
  createHttpTransport,
  remoteRateLimitErrorResponse,
  remoteUnauthorizedErrorResponse
} from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

async function expectGuardError(
  response: Response,
  expected: { status: number; code: string; message: string; retryable: boolean; details?: Record<string, unknown> }
) {
  const requestId = response.headers.get('x-monad-request-id');
  expect(response.status).toBe(expected.status);
  expect(requestId).toMatch(/^req_[0-9a-zA-Z]{12}$/);
  expect(await response.json()).toEqual({
    error: expected.message,
    code: expected.code,
    retryable: expected.retryable,
    requestId,
    ...(expected.details ? { details: expected.details } : {})
  });
}

test('live main browser guard uses the canonical forbidden response', async () => {
  const app = createHttpTransport(buildHandlers(mockModel(['ok'])));
  const response = await app.handle(
    new Request('http://localhost/v1/sessions', {
      headers: { origin: 'https://attacker.example' }
    })
  );
  await expectGuardError(response, { status: 403, code: 'FORBIDDEN', message: 'forbidden', retryable: false });
});

test('remote guard response functions preserve auth and rate-limit contracts', async () => {
  const unauthorized = remoteUnauthorizedErrorResponse(new Request('http://localhost/v1/health'));
  await expectGuardError(unauthorized, {
    status: 401,
    code: 'UNAUTHORIZED',
    message: 'unauthorized',
    retryable: false
  });

  const limited = remoteRateLimitErrorResponse(new Request('http://localhost/v1/health'), 3);
  expect(limited.headers.get('retry-after')).toBe('3');
  await expectGuardError(limited, {
    status: 429,
    code: 'RATE_LIMITED',
    message: 'too many requests',
    retryable: true,
    details: { retryAfterSeconds: 3 }
  });
});

test('system local-only guard rejects remote peers through the canonical projector', async () => {
  const request = new Request('http://localhost/v1/system/upgrade');
  // presence-ok: no response is the admission contract for loopback peers.
  expect(systemRemoteGuardResponse(request, '127.0.0.1')).toBeUndefined();
  const response = systemRemoteGuardResponse(request, '203.0.113.10');
  if (!response) throw new Error('remote system guard did not reject the peer');
  await expectGuardError(response, { status: 403, code: 'FORBIDDEN', message: 'forbidden', retryable: false });
});

test('WebSocket browser guard rejects cross-origin upgrades through the canonical projector', async () => {
  const allowed = new Request('http://localhost/v1/stream', {
    headers: { host: 'localhost', origin: 'http://localhost' }
  });
  // presence-ok: no response is the admission contract for an allowed upgrade.
  expect(streamBrowserGuardResponse(allowed, false)).toBeUndefined();

  const rejected = new Request('http://localhost/v1/stream', {
    headers: { host: 'localhost', origin: 'https://attacker.example' }
  });
  const response = streamBrowserGuardResponse(rejected, false);
  if (!response) throw new Error('cross-origin stream guard did not reject the upgrade');
  await expectGuardError(response, { status: 403, code: 'FORBIDDEN', message: 'forbidden', retryable: false });
});

test('browser guard response preserves allowed-origin CORS and rejects reflection', () => {
  const allowed = browserGuardErrorResponse(
    new Request('http://localhost/v1/health', {
      headers: { host: 'localhost', origin: 'http://localhost' }
    })
  );
  expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost');
  expect(allowed.headers.get('access-control-expose-headers')).toBe('x-monad-request-id');

  const rejected = browserGuardErrorResponse(
    new Request('http://localhost/v1/health', {
      headers: { host: 'localhost', origin: 'https://attacker.example' }
    })
  );
  // presence-ok: disallowed origins must never be reflected into CORS headers.
  expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
});

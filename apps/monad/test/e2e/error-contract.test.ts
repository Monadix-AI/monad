// Conformance guard for the HTTP error contract. The protocol declares httpErrorSchema
// ({ error, code? }) as the body of failed requests. The daemon's onError handler
// normalises EVERY failure — business errors, schema rejections, route misses, and server
// faults — into that one envelope, so clients decode a single shape. This test mounts the
// live daemon and asserts that guarantee holds end-to-end.

import { expect, test } from 'bun:test';
import { httpErrorSchema, publicErrorDescriptorSchema } from '@monad/protocol';

import { listen, mockModel } from '../helpers.ts';

function withApp(fn: (base: string) => Promise<void>) {
  return async () => {
    const { base, stop } = listen(mockModel());
    try {
      await fn(base);
    } finally {
      stop();
    }
  };
}

async function expectErrorEnvelope(res: Response) {
  expect(res.headers.get('content-type')).toContain('application/json');
  const rawBody = await res.json();
  const body = httpErrorSchema.parse(rawBody);
  if (!body.requestId) throw new Error('canonical HTTP error omitted requestId');
  expect(res.headers.get('x-monad-request-id')).toBe(body.requestId);
  expect(
    publicErrorDescriptorSchema.safeParse({
      code: body.code,
      message: body.error,
      retryable: body.retryable,
      requestId: body.requestId,
      ...(body.details ? { details: body.details } : {})
    }).success
  ).toBe(true);
  return body as {
    error: string;
    code: string;
    retryable: boolean;
    requestId: `req_${string}`;
    details?: Record<string, unknown>;
  };
}

function normalizeRequestId<T extends { requestId: string }>(body: T): Omit<T, 'requestId'> & { requestId: string } {
  return { ...body, requestId: '<request-id>' };
}

test(
  'business error (HandlerError) → mapped status + httpErrorSchema body',
  withApp(async (base) => {
    // A well-formed id for a session that does not exist is a 404 that names the missing id. It used
    // to be a 400 whose message was scrubbed to "request validation failed", which left a caller
    // unable to tell a malformed id from a session that is simply gone.
    const res = await fetch(`${base}/v1/sessions/ses_000000000000`);
    expect(res.status).toBe(404);
    const body = await expectErrorEnvelope(res);
    expect(normalizeRequestId(body)).toEqual({
      error: 'session not found: ses_000000000000',
      code: 'NOT_FOUND',
      retryable: false,
      requestId: '<request-id>'
    });
  })
);

test(
  'param validation failure → 400 + httpErrorSchema body',
  withApp(async (base) => {
    // Malformed id is rejected at the params schema before any handler runs; normalised to 400.
    const res = await fetch(`${base}/v1/sessions/not-a-valid-id`);
    expect(res.status).toBe(400);
    const body = await expectErrorEnvelope(res);
    expect(normalizeRequestId(body)).toEqual({
      error: 'request validation failed',
      code: 'VALIDATION',
      retryable: false,
      requestId: '<request-id>',
      details: { issues: ['request validation failed'] }
    });
  })
);

test(
  'body validation failure → 400 + httpErrorSchema body',
  withApp(async (base) => {
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bogus: 1 })
    });
    expect(res.status).toBe(400);
    const body = await expectErrorEnvelope(res);
    expect(normalizeRequestId(body)).toEqual({
      error: 'request validation failed',
      code: 'VALIDATION',
      retryable: false,
      requestId: '<request-id>',
      details: { issues: ['request validation failed'] }
    });
  })
);

test(
  'route miss → 404 + httpErrorSchema body (JSON, not plain text)',
  withApp(async (base) => {
    const res = await fetch(`${base}/v1/no-such-endpoint`);
    expect(res.status).toBe(404);
    const body = await expectErrorEnvelope(res);
    expect(normalizeRequestId(body)).toEqual({
      error: 'not found',
      code: 'NOT_FOUND',
      retryable: false,
      requestId: '<request-id>'
    });
  })
);

test(
  'distinct requests receive distinct correlation IDs',
  withApp(async (base) => {
    const first = await fetch(`${base}/v1/no-such-endpoint`);
    const second = await fetch(`${base}/v1/no-such-endpoint`);
    const firstBody = await expectErrorEnvelope(first);
    const secondBody = await expectErrorEnvelope(second);
    expect(normalizeRequestId(firstBody)).toEqual({
      error: 'not found',
      code: 'NOT_FOUND',
      retryable: false,
      requestId: '<request-id>'
    });
    expect(normalizeRequestId(secondBody)).toEqual({
      error: 'not found',
      code: 'NOT_FOUND',
      retryable: false,
      requestId: '<request-id>'
    });
    expect(secondBody.requestId).not.toBe(firstBody.requestId);
  })
);

test(
  'Workplace Project stale If-Match returns the canonical precondition envelope and current etag',
  withApp(async (base) => {
    const created = await fetch(`${base}/v1/workplace/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'etag project' })
    });
    const { projectId } = (await created.json()) as { projectId: string };
    const current = await fetch(`${base}/v1/workplace/projects/${projectId}`);
    const etag = current.headers.get('etag');
    // biome-ignore lint/plugin: the stale If-Match contract requires the current ETag to be returned
    expect(etag).not.toBeNull();
    const response = await fetch(`${base}/v1/workplace/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"stale"' },
      body: JSON.stringify({ title: 'should not update' })
    });
    expect(response.status).toBe(412);
    expect(response.headers.get('etag')).toBe(etag);
    const body = await expectErrorEnvelope(response);
    expect(normalizeRequestId(body)).toEqual({
      error: 'precondition failed',
      code: 'PRECONDITION_FAILED',
      retryable: false,
      requestId: '<request-id>'
    });
  })
);

test(
  'Session stale If-Match returns the canonical precondition envelope and current etag',
  withApp(async (base) => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'etag session' })
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const current = await fetch(`${base}/v1/sessions/${sessionId}`);
    const etag = current.headers.get('etag');
    // biome-ignore lint/plugin: the stale If-Match contract requires the current ETag to be returned
    expect(etag).not.toBeNull();
    const response = await fetch(`${base}/v1/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"stale"' },
      body: JSON.stringify({ title: 'should not update' })
    });
    expect(response.status).toBe(412);
    expect(response.headers.get('etag')).toBe(etag);
    const body = await expectErrorEnvelope(response);
    expect(normalizeRequestId(body)).toEqual({
      error: 'precondition failed',
      code: 'PRECONDITION_FAILED',
      retryable: false,
      requestId: '<request-id>'
    });
  })
);

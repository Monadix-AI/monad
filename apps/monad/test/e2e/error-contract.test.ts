// Conformance guard for the HTTP error contract. The protocol declares httpErrorSchema
// ({ error, code? }) as the body of failed requests. The daemon's onError handler
// normalises EVERY failure — business errors, schema rejections, route misses, and server
// faults — into that one envelope, so clients decode a single shape. This test mounts the
// live daemon and asserts that guarantee holds end-to-end.

import { expect, test } from 'bun:test';
import { httpErrorSchema } from '@monad/protocol';

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
  const body = await res.json();
  expect(httpErrorSchema.safeParse(body).success, `body not httpErrorSchema-shaped: ${JSON.stringify(body)}`).toBe(
    true
  );
  return body as { error: string; code?: string };
}

test(
  'business error (HandlerError) → 400 + httpErrorSchema body',
  withApp(async (base) => {
    // Valid id format that passes params validation but does not exist → HandlerError.
    const res = await fetch(`${base}/v1/sessions/undefined`);
    expect(res.status).toBe(400);
    await expectErrorEnvelope(res);
  })
);

test(
  'param validation failure → 400 + httpErrorSchema body',
  withApp(async (base) => {
    // Malformed id is rejected at the params schema before any handler runs; normalised to 400.
    const res = await fetch(`${base}/v1/sessions/not-a-valid-id`);
    expect(res.status).toBe(400);
    const body = await expectErrorEnvelope(res);
    expect(body.code).toBe('VALIDATION');
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
    expect(body.code).toBe('VALIDATION');
  })
);

test(
  'route miss → 404 + httpErrorSchema body (JSON, not plain text)',
  withApp(async (base) => {
    const res = await fetch(`${base}/v1/no-such-endpoint`);
    expect(res.status).toBe(404);
    const body = await expectErrorEnvelope(res);
    expect(body.code).toBe('NOT_FOUND');
  })
);

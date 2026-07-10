import { describe, expect, test } from 'bun:test';

import { createInMemoryHttpIdempotencyStore, withHttpIdempotency } from '#/transports/http/idempotency.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

const CREATE_KEY = 'idem_123456789abc';
const CONFLICT_KEY = 'idem_23456789abcd';
const AUTH_SCOPE_KEY = 'idem_3456789abcde';
const SEND_KEY = 'idem_456789abcdef';
const ERROR_KEY = 'idem_56789abcdef0';
const CONCURRENT_KEY = 'idem_6789abcdef01';
const TTL_KEY = 'idem_789abcdef012';

async function postJson(
  app: ReturnType<typeof createHttpTransport>,
  path: string,
  body: unknown,
  key?: string,
  headers?: Record<string, string>
) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
        ...headers
      },
      body: JSON.stringify(body)
    })
  );
  return { body: await res.json(), headers: res.headers, status: res.status };
}

describe('HTTP Idempotency-Key', () => {
  test('replays the first POST response for a duplicate key and body', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));

    const first = await postJson(app, '/v1/sessions', { title: 'idempotent create' }, CREATE_KEY);
    const second = await postJson(app, '/v1/sessions', { title: 'idempotent create' }, CREATE_KEY);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('idempotent-replayed')).toBe('true');

    const list = await app.handle(new Request('http://localhost/v1/sessions'));
    const sessions = ((await list.json()) as { sessions: Array<{ title: string }> }).sessions;
    expect(sessions.filter((session) => session.title === 'idempotent create')).toHaveLength(1);
  });

  test('rejects a duplicate key reused with a different body', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));

    const first = await postJson(app, '/v1/sessions', { title: 'first body' }, CONFLICT_KEY);
    const second = await postJson(app, '/v1/sessions', { title: 'second body' }, CONFLICT_KEY);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('scopes duplicate keys by authorization header', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));
    const body = { title: 'same key different auth' };

    const first = await postJson(app, '/v1/sessions', body, AUTH_SCOPE_KEY, { authorization: 'Bearer one' });
    const second = await postJson(app, '/v1/sessions', body, AUTH_SCOPE_KEY, { authorization: 'Bearer two' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).not.toEqual(first.body);
    expect(second.headers.get('idempotent-replayed')).toBeNull();
  });

  test('prevents duplicate message writes for a retried POST', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));
    const created = await postJson(app, '/v1/sessions', { title: 'message target' });
    const sessionId = (created.body as { sessionId: string }).sessionId;

    const body = { generate: false, text: 'only once' };
    const first = await postJson(app, `/v1/sessions/${sessionId}/messages`, body, SEND_KEY);
    const second = await postJson(app, `/v1/sessions/${sessionId}/messages`, body, SEND_KEY);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('idempotent-replayed')).toBe('true');

    const messagesResponse = await app.handle(new Request(`http://localhost/v1/sessions/${sessionId}/messages`));
    const messages = ((await messagesResponse.json()) as { messages: Array<{ text: string }> }).messages;
    expect(messages.filter((message) => message.text === 'only once')).toHaveLength(1);
  });

  test('replays handler errors instead of leaving the key in progress', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));
    const body = { generate: false, text: 'missing session' };

    const first = await postJson(app, '/v1/sessions/ses_missing00000/messages', body, ERROR_KEY);
    const second = await postJson(app, '/v1/sessions/ses_missing00000/messages', body, ERROR_KEY);

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
  });

  test('rejects non-nanoid idempotency keys', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));

    const res = await postJson(app, '/v1/sessions', { title: 'bad key' }, 'idem-human-readable');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION' });
  });

  test('handles concurrent duplicate keys without running the write twice', async () => {
    const app = createHttpTransport(buildHandlers(mockModel(['ok'])));
    const body = { title: 'concurrent idempotent create' };

    const [first, second] = await Promise.all([
      postJson(app, '/v1/sessions', body, CONCURRENT_KEY),
      postJson(app, '/v1/sessions', body, CONCURRENT_KEY)
    ]);

    expect([201, 409]).toContain(first.status);
    expect([201, 409]).toContain(second.status);

    const list = await app.handle(new Request('http://localhost/v1/sessions'));
    const sessions = ((await list.json()) as { sessions: Array<{ title: string }> }).sessions;
    expect(sessions.filter((session) => session.title === body.title)).toHaveLength(1);
  });

  test('keeps completed responses only for the configured short TTL', async () => {
    const store = createInMemoryHttpIdempotencyStore();
    let writes = 0;
    const run = () =>
      withHttpIdempotency({
        body: { title: 'ttl scoped' },
        handler: () => Response.json({ writes: ++writes }, { status: 201 }),
        method: 'POST',
        path: '/v1/sessions',
        request: new Request('http://localhost/v1/sessions', { headers: { 'idempotency-key': TTL_KEY } }),
        scope: 'POST:/v1/sessions',
        store,
        ttlMs: 5
      });

    const first = await run();
    const replayed = await run();
    await Bun.sleep(10);
    const afterTtl = await run();

    expect(first.status).toBe(201);
    expect(replayed.headers.get('idempotent-replayed')).toBe('true');
    expect(await replayed.json()).toEqual({ writes: 1 });
    expect(afterTtl.headers.get('idempotent-replayed')).toBeNull();
    expect(await afterTtl.json()).toEqual({ writes: 2 });
  });
});

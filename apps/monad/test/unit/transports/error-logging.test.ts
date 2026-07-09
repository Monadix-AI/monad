import type { LoggerRecord } from '@monad/logger';

import { afterEach, expect, test } from 'bun:test';
import { configureLogger } from '@monad/logger';

import { createHttpTransport } from '#/transports/http.ts';
import { createConnectionState } from '#/transports/jsonrpc/connection.ts';
import { handleRpcMessage } from '#/transports/jsonrpc/handler.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

function captureErrorLogs(): LoggerRecord[] {
  return captureLogs('error');
}

function captureLogs(level: 'debug' | 'error' | 'info'): LoggerRecord[] {
  const records: LoggerRecord[] = [];
  configureLogger({
    destinations: [
      {
        type: 'custom',
        name: 'transport-error-logging-test',
        level,
        write(record) {
          records.push(record);
        }
      }
    ]
  });
  return records;
}

afterEach(() => {
  configureLogger(undefined);
});

test('HTTP transport logs HandlerError and validation failures with exception stacks', async () => {
  const records = captureErrorLogs();
  const app = createHttpTransport(buildHandlers(mockModel()));

  await app.handle(new Request('http://localhost/v1/sessions/undefined'));
  await app.handle(new Request('http://localhost/v1/sessions/not-a-valid-id'));

  expect(records).toHaveLength(2);
  expect(records.map((record) => record.status)).toEqual([400, 400]);
  expect(records.every((record) => (record.err as { stack?: string } | undefined)?.stack)).toBe(true);
});

test('HTTP transport logs handler responses whose final status is 5xx', async () => {
  const records = captureErrorLogs();
  const app = createHttpTransport(buildHandlers(mockModel())).get('/unit-503', ({ set }) => {
    set.status = 503;
    return { error: 'service unavailable' };
  });

  const res = await app.handle(new Request('http://localhost/unit-503'));

  expect(res.status).toBe(503);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ method: 'GET', path: '/unit-503', status: 503 });
});

test('HTTP transport scopes session and channel request logs for developer traces', async () => {
  const records = captureLogs('debug');
  const app = createHttpTransport(buildHandlers(mockModel()))
    .get('/v1/projects/:id/unit-log', () => ({ ok: true }))
    .get('/v1/channels/:id/unit-log', () => ({ ok: true }));

  await app.handle(new Request('http://localhost/v1/projects/ses_100000000000/unit-log'));
  await app.handle(new Request('http://localhost/v1/channels/ch_100000000000/unit-log'));

  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'http.request',
      method: 'GET',
      path: '/v1/projects/ses_100000000000/unit-log',
      sessionId: 'ses_100000000000',
      status: 200
    })
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      channelId: 'ch_100000000000',
      event: 'http.request',
      method: 'GET',
      path: '/v1/channels/ch_100000000000/unit-log',
      status: 200
    })
  );
});

test('HTTP transport writes access logs to the primary log only while Developer Mode is live', async () => {
  let developerMode = false;
  const records = captureLogs('info');
  const app = createHttpTransport(buildHandlers(mockModel()), { developerMode: () => developerMode }).get(
    '/v1/projects/:id/unit-primary-log',
    () => ({ ok: true })
  );

  await app.handle(new Request('http://localhost/v1/projects/ses_100000000000/unit-primary-log'));
  expect(records).toEqual([]);

  developerMode = true;
  await app.handle(new Request('http://localhost/v1/projects/ses_100000000000/unit-primary-log'));

  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'http.request',
      method: 'GET',
      path: '/v1/projects/ses_100000000000/unit-primary-log',
      sessionId: 'ses_100000000000',
      status: 200
    })
  );
});

test('JSON-RPC transport logs handler exceptions with exception stacks', async () => {
  const records = captureErrorLogs();
  const replies: unknown[] = [];

  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sessions.get', params: { id: 'ses_NONEXISTENT0' } }),
    createConnectionState(),
    buildHandlers(mockModel()),
    (message) => replies.push(message),
    'unit-rpc'
  );

  expect(replies).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ transport: 'unit-rpc', method: 'sessions.get' });
});

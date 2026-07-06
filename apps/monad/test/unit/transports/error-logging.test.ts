import type { LoggerRecord } from '@monad/logger';

import { afterEach, expect, test } from 'bun:test';
import { configureLogger } from '@monad/logger';

import { createHttpTransport } from '@/transports/http.ts';
import { createConnectionState } from '@/transports/jsonrpc/connection.ts';
import { handleRpcMessage } from '@/transports/jsonrpc/handler.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

function captureErrorLogs(): LoggerRecord[] {
  const records: LoggerRecord[] = [];
  configureLogger({
    destinations: [
      {
        type: 'custom',
        name: 'transport-error-logging-test',
        level: 'error',
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

  await app.handle(new Request('http://localhost/v1/sessions/ses_NONEXISTENT'));
  await app.handle(new Request('http://localhost/v1/sessions/not-a-valid-id'));

  expect(records).toHaveLength(2);
  expect(records.map((record) => record.status)).toEqual([400, 400]);
  expect(records.every((record) => (record.err as { stack?: string } | undefined)?.stack)).toBe(true);
});

test('JSON-RPC transport logs handler exceptions with exception stacks', async () => {
  const records = captureErrorLogs();
  const replies: unknown[] = [];

  await handleRpcMessage(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sessions.get', params: { id: 'ses_NONEXISTENT' } }),
    createConnectionState(),
    buildHandlers(mockModel()),
    (message) => replies.push(message),
    'unit-rpc'
  );

  expect(replies).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ transport: 'unit-rpc', method: 'sessions.get' });
});

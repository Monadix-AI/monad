import { expect, test } from 'bun:test';
import {
  jsonRpcErrorResponse,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  jsonRpcResponseId
} from '@monad/atoms/agent-adapters/jsonrpc';

test('jsonRpcRequest frames a method/id/params line terminated by a newline', () => {
  const frame = jsonRpcRequest('turn/start', 7, { threadId: 't1' });
  expect(frame.endsWith('\n')).toBe(true);
  expect(JSON.parse(frame)).toEqual({ method: 'turn/start', id: 7, params: { threadId: 't1' } });
});

test('jsonRpcNotification omits the id and defaults params to an empty object', () => {
  expect(JSON.parse(jsonRpcNotification('initialized'))).toEqual({ method: 'initialized', params: {} });
});

test('jsonRpcResponse and jsonRpcErrorResponse frame result/error bodies', () => {
  expect(JSON.parse(jsonRpcResponse('r1', { decision: 'accept' }))).toEqual({
    id: 'r1',
    result: { decision: 'accept' }
  });
  expect(JSON.parse(jsonRpcErrorResponse(2, -32601, 'method not found'))).toEqual({
    id: 2,
    error: { code: -32601, message: 'method not found' }
  });
});

test('jsonRpcResponseId preserves a numeric request id over a stringified fallback', () => {
  expect(jsonRpcResponseId(17, '17')).toBe(17);
  expect(jsonRpcResponseId('req_1', 'req_1')).toBe('req_1');
  expect(jsonRpcResponseId(undefined, 'fallback')).toBe('fallback');
  expect(jsonRpcResponseId('', 'fallback')).toBe('fallback');
});

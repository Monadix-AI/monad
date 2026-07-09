import { expect, test } from 'bun:test';

import { METHOD_TABLE } from '../src/rpc/method-table.ts';
import { RPC_METHOD_PARAMS } from '../src/rpc/rpc-methods.ts';

test('path + body flatten into one params object on the wire', () => {
  const sid = 'ses_01KV8EP5YE7J';
  // sessions.update: path {id} ⊕ body {title?} → flat {id, title?}
  const update = RPC_METHOD_PARAMS['sessions.update'];
  expect(update.safeParse({ id: sid }).success).toBe(true);
  expect(update.safeParse({ id: sid, title: 'hi' }).success).toBe(true);
  expect(update.safeParse({ title: 'hi' }).success).toBe(false); // missing required path id

  // sessions.reset: path {id} only, no body → flat {id}
  const reset = RPC_METHOD_PARAMS['sessions.reset'];
  expect(reset.safeParse({ id: sid }).success).toBe(true);
  expect(reset.safeParse({}).success).toBe(false); // missing required path id
});

test('subscription methods ack synchronously', () => {
  expect(METHOD_TABLE['control.subscribe'].result.safeParse({ subscribed: true }).success).toBe(true);
  expect(METHOD_TABLE['control.subscribe'].result.safeParse({ subscribed: false }).success).toBe(false);
});

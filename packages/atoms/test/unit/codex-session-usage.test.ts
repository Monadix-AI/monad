import { expect, test } from 'bun:test';

import {
  codexSessionUsageFromNotification,
  readCodexSessionUsage
} from '../../src/agent-adapters/codex/session-usage.ts';

test('Codex token usage maps cumulative totals and current context independently', () => {
  expect(
    codexSessionUsageFromNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        tokenUsage: {
          total: {
            totalTokens: 600_426,
            inputTokens: 597_658,
            cachedInputTokens: 518_656,
            outputTokens: 2_768,
            reasoningOutputTokens: 845
          },
          last: {
            totalTokens: 72_693,
            inputTokens: 71_950,
            outputTokens: 743
          },
          modelContextWindow: 258_400
        }
      }
    })
  ).toEqual({
    total: 600_426,
    input: 597_658,
    output: 2_768,
    cachedInput: 518_656,
    reasoningOutput: 845,
    context: { used: 72_693, window: 258_400 }
  });
});

test('Codex session usage resumes with turns and returns the replayed notification', async () => {
  const writes: string[] = [];
  let killed = false;
  const output = [
    JSON.stringify({ id: 1, result: { userAgent: 'codex' } }),
    JSON.stringify({ id: 2, result: { thread: { id: 'thread-1' } } }),
    JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
          last: { totalTokens: 12 },
          modelContextWindow: 100
        }
      }
    })
  ].join('\n');
  const usage = await readCodexSessionUsage(
    {
      providerSessionRef: 'thread-1',
      workingPath: '/workspace',
      executable: '/bin/codex'
    },
    {
      spawn: () => ({
        stdin: { write: (chunk) => writes.push(chunk) },
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${output}\n`));
            controller.close();
          }
        }),
        kill: () => {
          killed = true;
        }
      })
    }
  );

  expect(usage).toEqual({
    total: 30,
    input: 20,
    output: 10,
    context: { used: 12, window: 100 }
  });
  expect(writes.map((line) => JSON.parse(line))).toEqual([
    {
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'monad', version: '0' }, capabilities: null }
    },
    { method: 'initialized' },
    { method: 'thread/resume', id: 2, params: { threadId: 'thread-1', includeTurns: true } }
  ]);
  expect(killed).toBe(true);
});

test('Codex archived sessions return no usage instead of leaking thread/resume errors', async () => {
  let killed = false;
  const usage = await readCodexSessionUsage(
    {
      providerSessionRef: 'thread-archived',
      workingPath: '/workspace',
      executable: '/bin/codex'
    },
    {
      spawn: () => ({
        stdin: { write: () => {} },
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  id: 2,
                  error: {
                    message:
                      'session thread-archived is archived. Run `codex unarchive thread-archived` to unarchive it first.'
                  }
                })}\n`
              )
            );
            controller.close();
          }
        }),
        kill: () => {
          killed = true;
        }
      })
    }
  );

  expect({ killed, usage }).toEqual({ killed: true, usage: null });
});

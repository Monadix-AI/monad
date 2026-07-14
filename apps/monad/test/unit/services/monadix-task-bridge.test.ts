import type { SubmitResultBody, TaskDispatchAckPayload, TaskDispatchedPayload } from '#/services/monadix/protocol.ts';

import { describe, expect, test } from 'bun:test';

import { createDispatchDeduper, handleDispatchedTask } from '#/services/monadix/task-bridge.ts';

const payload = (over: Partial<TaskDispatchedPayload> = {}): TaskDispatchedPayload => ({
  taskId: 'mtask_1',
  dispatchId: 'disp_1',
  description: 'do a thing',
  input: null,
  prompt: 'Summarize X',
  matchScore: null,
  timestamp: '2026-01-01T00:00:00.000Z',
  dispatchSecret: 'sek',
  ...over
});

function harness(runAgent: (t: { taskId: string; prompt: string }) => Promise<string>) {
  const acks: TaskDispatchAckPayload[] = [];
  const results: Array<{ taskId: string; body: SubmitResultBody }> = [];
  const deps = {
    providerId: 'prov_1',
    ack: async (p: TaskDispatchAckPayload) => {
      acks.push(p);
    },
    runAgent,
    submitResult: async (taskId: string, body: SubmitResultBody) => {
      results.push({ taskId, body });
    },
    now: () => '2026-01-01T00:00:00.000Z'
  };
  return { deps, acks, results };
}

describe('handleDispatchedTask', () => {
  test('acks then submits the agent output as a completed result (echoing dispatchSecret)', async () => {
    const { deps, acks, results } = harness(async () => 'the summary');
    await handleDispatchedTask(payload(), deps);
    expect(acks).toEqual([
      { dispatchId: 'disp_1', taskId: 'mtask_1', providerId: 'prov_1', timestamp: '2026-01-01T00:00:00.000Z' }
    ]);
    expect(results).toEqual([
      { taskId: 'mtask_1', body: { status: 'completed', output: { text: 'the summary' }, dispatchSecret: 'sek' } }
    ]);
  });

  test('acks before running the agent (ack is not blocked by the slow run)', async () => {
    const order: string[] = [];
    const { deps } = harness(async () => {
      order.push('run');
      return 'x';
    });
    const acking = deps.ack;
    deps.ack = async (p) => {
      order.push('ack');
      await acking(p);
    };
    await handleDispatchedTask(payload(), deps);
    expect(order).toEqual(['ack', 'run']);
  });

  test('a failing run submits a failed result rather than throwing', async () => {
    const { deps, results } = harness(async () => {
      throw new Error('model exploded');
    });
    await handleDispatchedTask(payload(), deps);
    expect(results).toHaveLength(1);
    expect(results[0]?.body.status).toBe('failed');
    expect(results[0]?.body.output).toEqual({ error: 'model exploded' });
  });
});

describe('createDispatchDeduper', () => {
  test('reports a repeated id as seen', () => {
    const d = createDispatchDeduper();
    expect(d.seen('a')).toBe(false);
    expect(d.seen('a')).toBe(true);
    expect(d.seen('b')).toBe(false);
  });

  test('evicts oldest past the bound so it never grows unbounded', () => {
    const d = createDispatchDeduper(2);
    d.seen('a');
    d.seen('b');
    d.seen('c'); // size > 2 → evicts oldest ('a'); now remembers {b, c}
    expect(d.seen('c')).toBe(true); // most recent still remembered
    expect(d.seen('a')).toBe(false); // 'a' forgotten → treated as new
  });
});

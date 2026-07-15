import type { HookDecision, HookInput, Hooks, SessionId } from '@monad/protocol';
import type { ModelRequest, ModelResult, ModelRouter } from '#/agent/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, InMemoryMessageRepo } from '#/agent/index.ts';
import { toolResult } from '#/capabilities/tools/types.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';

function baseDecision(i: HookInput): HookDecision {
  return {
    blocked: false,
    ask: false,
    allowed: false,
    additionalContext: [],
    effectivePrompt: i.prompt,
    effectiveToolInput: i.toolInput,
    effectiveToolOutput: i.toolResult
  };
}

/** A fake Hooks that applies a per-event patch on top of the pass-through decision. */
function fakeHooks(patch: (i: HookInput) => Partial<HookDecision>): Hooks {
  return { run: async (i) => ({ ...baseDecision(i), ...patch(i) }) };
}

function mockModel(text: string): ModelRouter {
  return buildMockModel().text([text]).build();
}

/** A model that only implements complete() — the block-mode (runBlock) tests never stream. */
function completeOnly(complete: ModelRouter['complete']): ModelRouter {
  return {
    // biome-ignore lint/correctness/useYield: block-mode test; stream() is never invoked
    async *stream(): AsyncGenerator<never> {
      throw new Error('stream() should not run in this test');
    },
    complete
  };
}

const sid = () => newId('ses') as SessionId;

/** A complete()-only model that calls `toolName` on the first step, then answers 'final'. */
function toolThenFinal(toolName: string): ModelRouter {
  let c = 0;
  return completeOnly(async (): Promise<ModelResult> => {
    c++;
    return c === 1
      ? { text: '', finishReason: 'stop', toolCalls: [{ toolCallId: 't1', toolName, input: {} }] }
      : { text: 'final', finishReason: 'stop' };
  });
}

test('BeforeTurn deny aborts the turn (model never runs) but keeps the user turn in history', async () => {
  const messages = new InMemoryMessageRepo();
  let modelRan = false;
  const model = completeOnly(async () => {
    modelRan = true;
    return { text: 'should not happen', finishReason: 'stop' };
  });
  const loop = new AgentLoop({
    model,
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'BeforeTurn' ? { blocked: true, reason: 'denied by policy' } : {}))
  });
  const id = sid();
  const msg = await loop.runBlock(id, 'do something risky');
  expect(msg.text).toBe('denied by policy');
  expect(modelRan).toBe(false);
  // Transcript fidelity: the denied prompt is persisted, followed by the policy reply.
  const history = messages.list(id);
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(history[0]?.text).toBe('do something risky');
  expect(history[1]?.text).toBe('denied by policy');
});

test('BeforeTurn modelOverride selects the model for the turn', async () => {
  let seenModel = '';
  const model = completeOnly(async (req: ModelRequest): Promise<ModelResult> => {
    seenModel = req.model;
    return { text: 'ok', finishReason: 'stop' };
  });
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'default-model',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'BeforeTurn' ? { modelOverride: 'override-model' } : {}))
  });
  await loop.runBlock(sid(), 'hi');
  expect(seenModel).toBe('override-model');
});

test('BeforeModel/AfterModel fire for the main loop (caller=main); AfterModel rewrites the response', async () => {
  const seen: { event: string; callerKind?: string }[] = [];
  const model = completeOnly(async (): Promise<ModelResult> => ({ text: 'raw answer', finishReason: 'stop' }));
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => {
      if (i.event === 'BeforeModel' || i.event === 'AfterModel')
        seen.push({ event: i.event, callerKind: i.caller?.kind });
      return i.event === 'AfterModel' ? { effectiveText: 'REDACTED' } : {};
    })
  });
  const msg = await loop.runBlock(sid(), 'hi');
  expect(msg.text).toBe('REDACTED');
  expect(seen.map((s) => s.event)).toEqual(['BeforeModel', 'AfterModel']);
  expect(seen.every((s) => s.callerKind === 'main')).toBe(true);
});

test('AfterModel fires per model step — including the intermediate tool-call response', async () => {
  const seenResponses: string[] = [];
  let call = 0;
  const model = completeOnly(async (): Promise<ModelResult> => {
    call++;
    if (call === 1)
      return {
        text: 'thinking',
        finishReason: 'stop',
        toolCalls: [{ toolCallId: 'tc1', toolName: 'noop', input: {} }]
      };
    return { text: 'final', finishReason: 'stop' };
  });
  const noopTool: Tool = { name: 'noop', description: 'no-op', scopes: [], run: async () => toolResult('ok') };
  const loop = new AgentLoop({
    model,
    tools: [noopTool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => {
      if (i.event === 'AfterModel') seenResponses.push(i.response ?? '');
      return {};
    })
  });
  const msg = await loop.runBlock(sid(), 'hi');
  expect(msg.text).toBe('final');
  // Fired once per model call (not once per turn) — the intermediate tool-call response is seen too.
  expect(seenResponses).toEqual(['thinking', 'final']);
});

test('ApprovalRequest can auto-deny or auto-approve a high-risk tool', async () => {
  const dangerous = (ran: { n: number }): Tool => ({
    name: 'rm',
    description: 'danger',
    scopes: [],
    highRisk: true,
    run: async () => {
      ran.n++;
      return toolResult('done');
    }
  });
  const denied = { n: 0 };
  await new AgentLoop({
    model: toolThenFinal('rm'),
    tools: [dangerous(denied)],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    gate: async () => ({ allow: true }),
    hooks: fakeHooks((i) => (i.event === 'ApprovalRequest' ? { blocked: true, reason: 'org policy' } : {}))
  }).runBlock(sid(), 'go');
  expect(denied.n).toBe(0); // hook auto-denied before the tool ran

  const approved = { n: 0 };
  await new AgentLoop({
    model: toolThenFinal('rm'),
    tools: [dangerous(approved)],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'ApprovalRequest' ? { allowed: true } : {}))
  }).runBlock(sid(), 'go');
  expect(approved.n).toBe(1); // hook auto-approved (no human gate needed)
});

test('BeforeTool deny skips the tool', async () => {
  let ran = 0;
  const tool: Tool = {
    name: 'noop',
    description: 'x',
    scopes: [],
    run: async () => {
      ran++;
      return toolResult('ok');
    }
  };
  await new AgentLoop({
    model: toolThenFinal('noop'),
    tools: [tool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'BeforeTool' ? { blocked: true, reason: 'no' } : {}))
  }).runBlock(sid(), 'go');
  expect(ran).toBe(0);
});

test('AfterTool sees ok=false and the error when a tool throws', async () => {
  let seen: { ok?: boolean; error?: string } = {};
  const boom: Tool = {
    name: 'boom',
    description: 'x',
    scopes: [],
    run: async () => {
      throw new Error('kaboom');
    }
  };
  await new AgentLoop({
    model: toolThenFinal('boom'),
    tools: [boom],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => {
      if (i.event === 'AfterTool') seen = { ok: i.ok, error: i.error };
      return {};
    })
  }).runBlock(sid(), 'go');
  expect(seen.ok).toBe(false);
  expect(seen.error).toContain('kaboom');
});

test('AfterTurn fires with reason=error when the turn fails', async () => {
  let seen: string | undefined;
  const model = completeOnly(async (): Promise<ModelResult> => {
    throw new Error('model down');
  });
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => {
      if (i.event === 'AfterTurn') seen = i.reason;
      return {};
    })
  });
  try {
    await loop.runBlock(sid(), 'hi');
  } catch {
    // expected — a failed turn rethrows after persisting the error
  }
  expect(seen).toBe('error');
});

test('AfterModel does NOT fire on a failed model call — failure surfaces via AfterTurn', async () => {
  const seen: string[] = [];
  const model = completeOnly(async (): Promise<ModelResult> => {
    throw new Error('model down');
  });
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => {
      seen.push(i.event);
      return {};
    })
  });
  try {
    await loop.runBlock(sid(), 'hi');
  } catch {
    // expected
  }
  expect(seen).toContain('BeforeModel'); // the model call was attempted
  expect(seen).not.toContain('AfterModel'); // …but it failed, so AfterModel (success-only) is skipped
});

test('an aborted streaming turn reports AfterTurn reason=aborted', async () => {
  let reason: string | undefined;
  const loop = new AgentLoop({
    model: mockModel('hello'),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => {
      if (i.event === 'AfterTurn') reason = i.reason;
      return {};
    })
  });
  const ac = new AbortController();
  ac.abort(); // abort before the stream is consumed → the loop breaks on the first chunk
  await loop.runStream(sid(), 'hi', ac.signal);
  expect(reason).toBe('aborted');
});

test('BeforeModel deny aborts the model call', async () => {
  let modelRan = false;
  const model = completeOnly(async (): Promise<ModelResult> => {
    modelRan = true;
    return { text: 'x', finishReason: 'stop' };
  });
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'BeforeModel' ? { blocked: true, reason: 'no model' } : {}))
  });
  // A BeforeModel deny aborts the model call — the turn errors out (persisted via the error path).
  let threw = false;
  try {
    await loop.runBlock(sid(), 'hi');
  } catch {
    threw = true;
  }
  expect(modelRan).toBe(false);
  expect(threw).toBe(true);
});

test('BeforeTurn modelOverride is dropped when the daemon disallows it', async () => {
  let seenModel = '';
  const model = completeOnly(async (req: ModelRequest): Promise<ModelResult> => {
    seenModel = req.model;
    return { text: 'ok', finishReason: 'stop' };
  });
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'default-model',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'BeforeTurn' ? { modelOverride: 'bogus-model' } : {})),
    isModelAllowed: (m) => m === 'allowed-model'
  });
  await loop.runBlock(sid(), 'hi');
  expect(seenModel).toBe('default-model'); // bogus override dropped, default kept
});

test('Stop mutatedText rewrites the final answer', async () => {
  const loop = new AgentLoop({
    model: mockModel('original'),
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'AfterTurn' ? { effectiveText: 'REWRITTEN' } : {}))
  });
  const msg = await loop.runBlock(sid(), 'hi');
  expect(msg.text).toBe('REWRITTEN');
});

test('Stop continueWork forces the agent to keep working (loop re-enters), bounded', async () => {
  let calls = 0;
  const model = completeOnly(async (): Promise<ModelResult> => {
    calls++;
    return { text: `answer-${calls}`, finishReason: 'stop' };
  });
  let stopCalls = 0;
  const hooks: Hooks = {
    run: async (i) => {
      const d = baseDecision(i);
      if (i.event === 'AfterTurn') {
        stopCalls++;
        if (stopCalls === 1) d.continueWork = { reason: 'not done — keep going' };
      }
      return d;
    }
  };
  const noopTool: Tool = { name: 'noop', description: 'no-op', scopes: [], run: async () => toolResult('ok') };
  const loop = new AgentLoop({
    model,
    tools: [noopTool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    hooks,
    maxStopContinues: 2
  });
  const msg = await loop.runBlock(sid(), 'hi');
  expect(calls).toBe(2); // re-entered exactly once
  expect(msg.text).toBe('answer-2');
});

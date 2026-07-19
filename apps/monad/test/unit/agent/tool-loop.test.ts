import type { Event, HookDecision, HookInput, Hooks, SessionId } from '@monad/protocol';
import type { ModelContentPart, ModelMessage, ModelResult, ModelRouter, ToolSpec } from '#/agent/index.ts';
import type { Tool, ToolGate } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';
import { z } from 'zod';

import { AgentLoop, InMemoryMessageRepo, replayHistory } from '#/agent/index.ts';
import { fileReadTool } from '#/capabilities/tools';
import { toolResult } from '#/capabilities/tools/types.ts';

// A scripted step is either a final text answer (string) or a tool call the model requests.
type Step = string | { tool: string; input?: unknown };

function toResult(step: Step, seq: number): ModelResult {
  if (typeof step === 'string') return { text: step, finishReason: 'stop' };
  return {
    text: '',
    toolCalls: [{ toolCallId: `tc_${seq}`, toolName: step.tool, input: step.input ?? {} }],
    finishReason: 'tool-calls'
  };
}

/** Returns each scripted step once (via complete), then a fixed fallback when exhausted. */
function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step = i < steps.length ? (steps[i] as Step) : 'FALLBACK';
      i++;
      return toResult(step, i);
    }
  };
}

const echoTool: Tool<{ v: unknown }, string> = {
  name: 'test.echo',
  description: 'echo input',
  scopes: [],
  run: async ({ v }) => toolResult(`echoed:${JSON.stringify(v)}`)
};

// A high-risk probe for the approval-gate tests — decoupled from any real tool's behaviour.
const highRiskProbe: Tool<Record<string, never>, string> = {
  name: 'test.highrisk',
  description: 'high-risk probe',
  scopes: [],
  highRisk: true,
  run: async () => toolResult('ran')
};

const ansiTool: Tool<Record<string, never>, string> = {
  name: 'shell_exec',
  description: 'ansi output',
  scopes: [],
  run: async () => toolResult('\x1B[31mred\x1B[0m plain')
};

const nonWhitelistedAnsiTool: Tool<Record<string, never>, string> = {
  name: 'test.ansi',
  description: 'ansi output from a non-terminal tool',
  scopes: [],
  run: async () => toolResult('\x1B[31mred\x1B[0m plain')
};

const displayTool: Tool<Record<string, never>, { summary: string }> = {
  name: 'test.display',
  description: 'structured display output',
  scopes: [],
  run: async () =>
    toolResult(
      { summary: 'changed file' },
      {
        displayContent: {
          type: 'diff',
          path: '/tmp/a.txt',
          beforeText: 'old',
          afterText: 'new',
          diff: '--- a.txt\tBefore\n+++ a.txt\tAfter\n@@ -1 +1 @@\n-old\n+new\n'
        }
      }
    )
};

const modelTextTool: Tool<Record<string, never>, { summary: string; secretDisplayOnly: string }> = {
  name: 'test.model-text',
  description: 'custom model-facing text',
  scopes: [],
  run: async () =>
    toolResult(
      { summary: 'changed file', secretDisplayOnly: 'before/after full text' },
      { modelContent: 'changed file', displayContent: { type: 'text', text: 'before/after full text' } }
    )
};

function baseHookDecision(i: HookInput): HookDecision {
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

function fakeHooks(patch: (i: HookInput) => Partial<HookDecision>): Hooks {
  return { run: async (i) => ({ ...baseHookDecision(i), ...patch(i) }) };
}

function harness(
  steps: Step[],
  opts: { tools?: Tool[]; sandboxRoots?: string[]; gate?: ToolGate; maxTurns?: number; hooks?: Hooks } = {}
) {
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: scriptedModel(steps),
    tools: opts.tools ?? [],
    messages,
    defaultModel: 'mock',
    emit: (e) => events.push(e),
    sandboxRoots: opts.sandboxRoots,
    gate: opts.gate,
    maxTurns: opts.maxTurns,
    hooks: opts.hooks
  });
  return { loop, events, messages };
}

/** Like scriptedModel, but stream() emits native chunks: text char-by-char, or a tool-call. */
function scriptedStreamModel(steps: Step[]): ModelRouter {
  let i = 0;
  const next = (): Step => {
    if (i < steps.length) return steps[i++] as Step;
    i++;
    return 'FALLBACK';
  };
  return {
    async *stream() {
      const step = next();
      if (typeof step === 'string') {
        for (const ch of step) yield { type: 'text' as const, token: ch };
      } else {
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: `tc_${i}`, toolName: step.tool, input: step.input ?? {} }
        };
      }
    },
    async complete(): Promise<ModelResult> {
      return toResult(next(), i);
    }
  };
}

function streamHarness(steps: Step[], opts: { tools?: Tool[]; sandboxRoots?: string[] } = {}) {
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: scriptedStreamModel(steps),
    tools: opts.tools ?? [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e),
    sandboxRoots: opts.sandboxRoots
  });
  return { loop, events };
}

const sid = () => newId('ses') as SessionId;
const eventMessage = (event: Event | undefined): { text?: string } | undefined =>
  (event?.payload as { message?: { text?: string } } | undefined)?.message;
const called = (events: Event[]) => events.filter((e) => e.type === 'tool.called');
const results = (events: Event[]) => events.filter((e) => e.type === 'tool.result');
const tokens = (events: Event[]) =>
  events.filter((e) => e.type === 'session.message.delta.appended' && e.payload.channel === 'answer');
const streamedText = (events: Event[]) =>
  tokens(events)
    .map((e) => e.payload.delta)
    .join('');

test('runs a tool then returns the final prose answer', async () => {
  const { loop, events } = harness([{ tool: 'test.echo', input: { v: 5 } }, 'the answer is 5'], { tools: [echoTool] });
  const msg = await loop.runBlock(sid(), 'hi');

  expect(msg.text).toBe('the answer is 5');
  expect(called(events)).toHaveLength(1);
  expect(called(events)[0]?.payload.tool).toBe('test.echo');
  expect(results(events)[0]?.payload).toMatchObject({ tool: 'test.echo', ok: true });
  expect(results(events)[0]?.payload.result).toContain('echoed:');
});

test('strips ANSI from model text while persisting raw whitelisted tool output', async () => {
  const { loop, events, messages } = harness([{ tool: 'shell_exec' }, 'done'], { tools: [ansiTool] });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'hi');

  const result = results(events)[0]?.payload as { result?: string; displayResult?: string } | undefined;
  expect(result?.result).toBe('red plain');
  expect(result?.displayResult).toBe('\x1B[31mred\x1B[0m plain');

  const persisted = messages.list(sessionId).find((m) => m.type === 'tool_result');
  expect(persisted?.text).toBe('red plain');
  expect((persisted?.data as { output?: string } | undefined)?.output).toBe('\x1B[31mred\x1B[0m plain');

  const replayed = replayHistory(messages.list(sessionId));
  const replayedTool = replayed.find((m) => m.role === 'tool');
  const replayedPart = Array.isArray(replayedTool?.content)
    ? replayedTool.content.find((p) => p.type === 'tool-result')
    : undefined;
  expect(replayedPart).toMatchObject({ output: 'red plain' });
});

test('does not strip ANSI for tool results outside the terminal whitelist', async () => {
  const { loop, events, messages } = harness([{ tool: 'test.ansi' }, 'done'], { tools: [nonWhitelistedAnsiTool] });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'hi');

  const result = results(events)[0]?.payload as { result?: string; displayResult?: string } | undefined;
  expect(result?.result).toBe('\x1B[31mred\x1B[0m plain');

  const replayed = replayHistory(messages.list(sessionId));
  const replayedTool = replayed.find((m) => m.role === 'tool');
  const replayedPart = Array.isArray(replayedTool?.content)
    ? replayedTool.content.find((p) => p.type === 'tool-result')
    : undefined;
  expect(replayedPart).toMatchObject({ output: '\x1B[31mred\x1B[0m plain' });
});

test('plain prose with tools registered short-circuits (no tool call)', async () => {
  const { loop } = harness(['just answering directly'], { tools: [echoTool] });
  const msg = await loop.runBlock(sid(), 'hi');
  expect(msg.text).toBe('just answering directly');
});

test('runs multiple tool calls from one step (parallel) and orders results by call', async () => {
  // A model that requests TWO tool calls in the first step, then answers.
  let step = 0;
  const model: ModelRouter = {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      if (step++ === 0) {
        return {
          text: '',
          toolCalls: [
            { toolCallId: 'a', toolName: 'test.echo', input: { v: 1 } },
            { toolCallId: 'b', toolName: 'test.echo', input: { v: 2 } }
          ],
          finishReason: 'tool-calls'
        };
      }
      return { text: 'both done', finishReason: 'stop' };
    }
  };
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const s = sid();
  const loop = new AgentLoop({ model, tools: [echoTool], messages, defaultModel: 'mock', emit: (e) => events.push(e) });
  const msg = await loop.runBlock(s, 'hi');

  expect(msg.text).toBe('both done');
  expect(called(events)).toHaveLength(2); // both executed
  // The tool results feed back in call order (a before b).
  const toolRows = messages.list(s).filter((m) => m.type === 'tool_result');
  expect(toolRows.map((m) => m.text.includes('echoed:1') || m.text.includes('echoed:2'))).toEqual([true, true]);
  expect(toolRows[0]?.text).toContain('echoed:1');
  expect(toolRows[1]?.text).toContain('echoed:2');
});

test('inserts steer messages after every parallel tool finishes and before the next model step', async () => {
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const seenPrompts: ModelMessage[][] = [];
  let modelStep = 0;
  let reopenCount = 0;
  const pendingSteers = ['adjust the answer'];
  const model: ModelRouter = {
    async *stream(req) {
      seenPrompts.push(req.messages.slice());
      if (modelStep++ === 0) {
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: 'parallel-a', toolName: 'test.parallel', input: { delay: 15 } }
        };
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: 'parallel-b', toolName: 'test.parallel', input: { delay: 1 } }
        };
        return;
      }
      yield { type: 'text' as const, token: 'updated' };
    },
    async complete(): Promise<ModelResult> {
      return { text: 'unused', finishReason: 'stop' };
    }
  };
  const parallelTool: Tool<{ delay: number }, string> = {
    name: 'test.parallel',
    description: 'parallel completion probe',
    scopes: [],
    run: async ({ delay }) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return toolResult(`finished:${delay}`);
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [parallelTool],
    messages,
    defaultModel: 'mock',
    emit: (event) => events.push(event),
    steers: {
      take: () => pendingSteers.splice(0),
      close: () => pendingSteers.splice(0),
      reopen: () => {
        reopenCount++;
      }
    }
  });

  await loop.runStream(sid(), 'start');

  const lastToolResult = events.findLastIndex((event) => event.type === 'tool.result');
  const steerMessage = events.findIndex(
    (event) => event.type === 'session.message.created' && eventMessage(event)?.text === 'adjust the answer'
  );
  expect(lastToolResult).toBeGreaterThan(-1);
  expect(steerMessage).toBeGreaterThan(lastToolResult);
  expect(reopenCount).toBe(0);
  expect(seenPrompts).toHaveLength(2);
  expect(seenPrompts[1]?.at(-1)).toMatchObject({ role: 'user', content: 'adjust the answer' });
  const persistedRoles = messages.list((events[0] as Event).sessionId).map((message) => message.role);
  expect(persistedRoles.lastIndexOf('tool')).toBeLessThan(persistedRoles.lastIndexOf('user'));
});

test('accepts a steer submitted during the budget-limited final generation', async () => {
  const events: Event[] = [];
  const messages = new InMemoryMessageRepo();
  const pendingSteers: string[] = [];
  const seenPrompts: ModelMessage[][] = [];
  let modelStep = 0;
  const model: ModelRouter = {
    async *stream(req) {
      seenPrompts.push(req.messages.slice());
      modelStep++;
      if (modelStep === 1) {
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: 'budget-tool', toolName: 'test.echo', input: { v: 1 } }
        };
        return;
      }
      if (modelStep === 2) {
        yield { type: 'text' as const, token: 'first final' };
        pendingSteers.push('change the final answer');
        return;
      }
      yield { type: 'text' as const, token: 'changed final' };
    },
    async complete(): Promise<ModelResult> {
      return { text: 'unused', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [echoTool],
    messages,
    defaultModel: 'mock',
    emit: (event) => events.push(event),
    maxTurns: 1,
    steers: {
      take: () => pendingSteers.splice(0),
      close: () => pendingSteers.splice(0),
      reopen: () => {}
    }
  });

  await loop.runStream(sid(), 'start');

  expect(seenPrompts).toHaveLength(3);
  expect(seenPrompts[2]?.at(-1)).toMatchObject({ role: 'user', content: 'change the final answer' });
  expect(
    events.some(
      (event) => event.type === 'session.message.created' && eventMessage(event)?.text === 'change the final answer'
    )
  ).toBe(true);
  expect(eventMessage(events.filter((event) => event.type === 'session.message.completed').at(-1))?.text).toBe(
    'changed final'
  );
});

test('a huge tool result is truncated before being fed back to the model', async () => {
  const huge = 'X'.repeat(100_000);
  const bigTool: Tool<Record<string, never>, string> = {
    name: 'test.big',
    description: 'returns a huge string',
    scopes: [],
    run: async () => toolResult(huge)
  };
  const seen: ModelMessage[][] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seen.push(req.messages.slice());
      return seen.length === 1
        ? { text: '', toolCalls: [{ toolCallId: 't', toolName: 'test.big', input: {} }], finishReason: 'tool-calls' }
        : { text: 'done', finishReason: 'stop' };
    }
  };
  const loop = new AgentLoop({
    model,
    tools: [bigTool as Tool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    maxToolResultChars: 1000
  });
  await loop.runBlock(sid(), 'go');

  // The 2nd prompt carries the tool result; it must be capped well below the raw 100k.
  const toolMsg = (seen[1] as ModelMessage[]).find((m) => m.role === 'tool');
  const out = ((toolMsg?.content as ModelContentPart[] | undefined) ?? []).find((p) => p.type === 'tool-result') as {
    output: string;
  };
  expect(out.output.length).toBeLessThan(2000);
});

test('a truncated result is still spilled when an AfterTool hook only appends context (pass-through effectiveToolOutput)', async () => {
  const huge = 'X'.repeat(100_000);
  const bigTool: Tool<Record<string, never>, string> = {
    name: 'test.big',
    description: 'returns a huge string',
    scopes: [],
    run: async () => toolResult(huge)
  };
  const spilled: Array<{ toolCallId: string; output: string }> = [];
  const loop = new AgentLoop({
    model: scriptedModel([{ tool: 'test.big' }, 'done']),
    tools: [bigTool as Tool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    maxToolResultChars: 1000,
    persistRawToolOutput: (_sessionId, toolCallId, output) => spilled.push({ toolCallId, output }),
    // A real hook runner's NO_HOOKS / pass-through decision also sets effectiveToolOutput to the
    // input toolResult (see @monad/protocol NO_HOOKS) — this hook mirrors that shape, only adding
    // additionalContext, to prove the spill isn't blocked by mere presence of effectiveToolOutput.
    hooks: fakeHooks((i) => (i.event === 'AfterTool' ? { additionalContext: ['policy note'] } : {}))
  });
  await loop.runBlock(sid(), 'go');

  expect(spilled).toHaveLength(1);
  expect(spilled[0]?.toolCallId).toBe('tc_1');
  expect(spilled[0]?.output).toBe(huge); // the full pre-truncation bytes, not the capped copy
});

test('a truncated result is NOT spilled when an AfterTool hook actually rewrites (redacts) the output', async () => {
  const huge = 'X'.repeat(100_000);
  const bigTool: Tool<Record<string, never>, string> = {
    name: 'test.big',
    description: 'returns a huge string',
    scopes: [],
    run: async () => toolResult(huge)
  };
  const spilled: unknown[] = [];
  const loop = new AgentLoop({
    model: scriptedModel([{ tool: 'test.big' }, 'done']),
    tools: [bigTool as Tool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    maxToolResultChars: 1000,
    persistRawToolOutput: (...args) => spilled.push(args),
    hooks: fakeHooks((i) => (i.event === 'AfterTool' ? { effectiveToolOutput: 'redacted' } : {}))
  });
  await loop.runBlock(sid(), 'go');

  expect(spilled).toHaveLength(0);
});

test('a secret buried in the OMITTED MIDDLE of a truncated output is not spilled, even though the truncated preview never shows it to the redaction hook', async () => {
  // 100k chars; truncateToolOutput(maxResultChars=1000) keeps head=700 + tail=300 of the ORIGINAL.
  // Put the secret at position 50_000 — well outside both windows, so the hook never sees it in the
  // truncated pass. Only a hook run against the FULL text can catch it.
  const secret = 'SECRET_MARKER_sk-live-abc123';
  const huge = `${'A'.repeat(50_000)}${secret}${'B'.repeat(50_000 - secret.length)}`;
  const bigTool: Tool<Record<string, never>, string> = {
    name: 'test.big',
    description: 'returns a huge string with a buried secret',
    scopes: [],
    run: async () => toolResult(huge)
  };
  const spilled: unknown[] = [];
  const hookCalls: string[] = [];
  const loop = new AgentLoop({
    model: scriptedModel([{ tool: 'test.big' }, 'done']),
    tools: [bigTool as Tool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    maxToolResultChars: 1000,
    persistRawToolOutput: (...args) => spilled.push(args),
    hooks: fakeHooks((i) => {
      if (i.event !== 'AfterTool') return {};
      hookCalls.push(i.toolResult ?? '');
      // A realistic redaction hook: only touches output that actually contains the secret pattern —
      // the truncated preview (head/tail only) never contains it, so this hook would silently pass
      // it through if the spill decision only consulted the truncated pass.
      return i.toolResult?.includes('SECRET_MARKER') ? { effectiveToolOutput: '[REDACTED]' } : {};
    })
  });
  await loop.runBlock(sid(), 'go');

  // Exactly one AfterTool pass ran, against the FULL pre-truncation text — so it actually saw the
  // secret (a truncated-preview-only pass would have missed it, per the scenario name).
  expect(hookCalls).toHaveLength(1);
  expect(hookCalls[0]).toContain('SECRET_MARKER');
  expect(spilled).toHaveLength(0); // spill correctly blocked — the secret is not recoverable via a handle
});

test('sandbox guard is enforced through the loop (file_read traversal → tool error)', async () => {
  const { loop, events } = harness([{ tool: 'file_read', input: { path: '/etc/passwd' } }, 'done'], {
    tools: [fileReadTool],
    sandboxRoots: ['/home/u/workspace']
  });
  const msg = await loop.runBlock(sid(), 'read it');

  expect(msg.text).toBe('done');
  expect(results(events)[0]?.payload).toMatchObject({ ok: false });
});

test('malformed tool input is rejected by the schema and surfaced as a tool error', async () => {
  // file_read requires a non-empty `path`; the model supplies none.
  const { loop, events } = harness([{ tool: 'file_read', input: {} }, 'done'], {
    tools: [fileReadTool],
    sandboxRoots: ['/home/u/workspace']
  });
  const msg = await loop.runBlock(sid(), 'read it');

  expect(msg.text).toBe('done');
  expect(results(events)[0]?.payload).toMatchObject({ ok: false });
  expect(results(events)[0]?.payload.result).toContain('invalid input');
});

test('high-risk tool is denied when no gate is configured (fail-closed)', async () => {
  const { loop, events } = harness([{ tool: 'test.highrisk', input: {} }, 'could not run'], {
    tools: [highRiskProbe]
  });
  const msg = await loop.runBlock(sid(), 'do the risky thing');

  expect(msg.text).toBe('could not run');
  expect(results(events)[0]?.payload).toMatchObject({ ok: false });
  expect(results(events)[0]?.payload.result).toContain('approval gate');
});

test('high-risk tool runs when an allowing gate is configured', async () => {
  const gate: ToolGate = async () => ({ allow: true });
  const { loop, events } = harness([{ tool: 'test.highrisk', input: {} }, 'ok'], {
    tools: [highRiskProbe],
    gate
  });
  const msg = await loop.runBlock(sid(), 'do the risky thing');

  expect(msg.text).toBe('ok');
  expect(results(events)[0]?.payload).toMatchObject({ ok: true, result: 'ran' }); // past the gate, into run()
});

/** A model that records the messages + tool specs it was asked to complete, per step. */
function capturingModel(steps: Step[]): {
  model: ModelRouter;
  prompts: ModelMessage[][];
  toolSpecs: (ToolSpec[] | undefined)[];
} {
  const prompts: ModelMessage[][] = [];
  const toolSpecs: (ToolSpec[] | undefined)[] = [];
  let i = 0;
  return {
    prompts,
    toolSpecs,
    model: {
      async *stream() {},
      async complete(req): Promise<ModelResult> {
        prompts.push(req.messages.slice()); // snapshot: the loop mutates the array across steps
        toolSpecs.push(req.tools);
        const step = i < steps.length ? (steps[i] as Step) : 'FALLBACK';
        i++;
        return toResult(step, i);
      }
    }
  };
}

test('a tool with structured modelContent feeds multimodal content back to the model', async () => {
  const { model, prompts } = capturingModel([{ tool: 'img.make' }, 'done']);
  const messages = new InMemoryMessageRepo();
  const imgTool: Tool<Record<string, never>, { path: string }> = {
    name: 'img.make',
    description: 'makes an image',
    scopes: [],
    run: async () =>
      toolResult(
        { path: '/tmp/x.png' },
        { modelContent: [{ type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }] }
      )
  };
  const loop = new AgentLoop({
    model,
    tools: [imgTool as Tool],
    messages,
    defaultModel: 'mock',
    emit: () => {}
  });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'make an image');

  // The 2nd model call saw a structured tool-result message AND the image as multimodal content.
  const second = prompts[1] as ModelMessage[];
  expect(second.some((m) => m.role === 'tool')).toBe(true);
  const hasImage = second.some(
    (m) => Array.isArray(m.content) && (m.content as ModelContentPart[]).some((p) => p.type === 'image')
  );
  expect(hasImage).toBe(true);
  const persisted = messages.list(sessionId).find((m) => m.type === 'tool_result')?.data as
    | {
        rawResult?: unknown;
      }
    | undefined;
  expect(persisted?.rawResult).toBeUndefined();
});

test('AfterTool redaction drops original multimodal tool parts', async () => {
  const { model, prompts } = capturingModel([{ tool: 'img.secret' }, 'done']);
  const messages = new InMemoryMessageRepo();
  const imgTool: Tool<Record<string, never>, { secret: string }> = {
    name: 'img.secret',
    description: 'returns a sensitive image',
    scopes: [],
    run: async () =>
      toolResult(
        { secret: 'sk-live-secret' },
        {
          modelContent: [
            { type: 'text', text: 'raw secret sk-live-secret' },
            { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
          ]
        }
      )
  };
  const loop = new AgentLoop({
    model,
    tools: [imgTool as Tool],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    hooks: fakeHooks((i) => (i.event === 'AfterTool' ? { effectiveToolOutput: 'redacted result' } : {}))
  });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'make an image');

  const second = prompts[1] as ModelMessage[];
  const hasImage = second.some(
    (m) => Array.isArray(m.content) && (m.content as ModelContentPart[]).some((p) => p.type === 'image')
  );
  expect(hasImage).toBe(false);
});

test('persists structured display output on tool result events and rows', async () => {
  const { loop, events, messages } = harness([{ tool: 'test.display' }, 'done'], { tools: [displayTool] });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'hi');

  const result = results(events)[0]?.payload as { display?: unknown; result?: string } | undefined;
  expect(result?.result).toBe('{"summary":"changed file"}');
  expect(result?.display).toEqual({
    type: 'diff',
    path: '/tmp/a.txt',
    beforeText: 'old',
    afterText: 'new',
    diff: '--- a.txt\tBefore\n+++ a.txt\tAfter\n@@ -1 +1 @@\n-old\n+new\n'
  });

  const rows = await messages.list(sessionId);
  const persisted = rows.find((row) => row.type === 'tool_result')?.data as
    | {
        display?: unknown;
        result?: { modelContent?: unknown; displayContent?: unknown };
        rawResult?: { modelContent?: unknown };
      }
    | undefined;
  expect(persisted?.display).toEqual(result?.display);
  expect(persisted?.result).toMatchObject({
    modelContent: '{"summary":"changed file"}',
    displayContent: result?.display
  });
});

test('uses custom model-facing tool output without leaking display-only data into the model observation', async () => {
  const { loop, events, messages } = harness([{ tool: 'test.model-text' }, 'done'], { tools: [modelTextTool] });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'hi');

  const result = results(events)[0]?.payload as { result?: string; display?: unknown } | undefined;
  expect(result?.result).toBe('changed file');
  expect(result?.display).toEqual({ type: 'text', text: 'before/after full text' });

  const rows = await messages.list(sessionId);
  const persisted = rows.find((row) => row.type === 'tool_result');
  expect(persisted?.text).toBe('changed file');
  expect((persisted?.data as { output?: string; display?: unknown } | undefined)?.output).toBe('changed file');
  expect((persisted?.data as { output?: string; display?: unknown } | undefined)?.display).toEqual(result?.display);
});

test('AfterTool redaction prevents raw tool result persistence', async () => {
  const secretTool: Tool<Record<string, never>, { secret: string }> = {
    name: 'test.secret',
    description: 'returns a secret',
    scopes: [],
    run: async () =>
      toolResult(
        { secret: 'sk-live-secret' },
        {
          modelContent: 'raw secret sk-live-secret',
          displayContent: { type: 'text', text: 'raw secret sk-live-secret' }
        }
      )
  };
  const { loop, messages } = harness([{ tool: 'test.secret' }, 'done'], {
    tools: [secretTool],
    hooks: fakeHooks((i) =>
      i.event === 'AfterTool' ? { effectiveToolOutput: 'redacted result', additionalContext: [] } : {}
    )
  });
  const sessionId = sid();
  await loop.runBlock(sessionId, 'hi');

  const row = messages.list(sessionId).find((m) => m.type === 'tool_result');
  expect(row?.text).toBe('redacted result');
  const serialized = JSON.stringify(row?.data);
  expect(serialized).toContain('redacted result');
  expect(serialized).not.toContain('sk-live-secret');
});

test('zod tool schema (descriptions + examples) reaches the model as a native spec', async () => {
  const { model, toolSpecs } = capturingModel(['hello']);
  const exInput = z.object({ a: z.number().describe('the magic number') });
  const exTool: Tool<{ a: number }, string> = {
    name: 'test.ex',
    description: 'example tool',
    scopes: [],
    inputSchema: exInput,
    inputExamples: [{ a: 1 }],
    run: async () => toolResult('x')
  };
  const loop = new AgentLoop({
    model,
    tools: [exTool as Tool],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {}
  });
  await loop.runBlock(sid(), 'go');

  const spec = (toolSpecs[0] ?? []).find((s) => s.name === 'test.ex');
  const json = JSON.stringify(spec?.parameters);
  expect(json).toContain('the magic number'); // zod .describe() flows to the model-facing schema
  expect(json).toContain('examples'); // inputExamples ride along
});

test('stops after the tool-step budget and forces a direct answer', async () => {
  const call: Step = { tool: 'test.echo', input: {} };
  // Exactly `maxTurns` tool-calls scripted → the forced final completion hits the
  // exhausted-script fallback, proving the loop stopped calling tools.
  const { loop, events } = harness([call, call], { tools: [echoTool], maxTurns: 2 });
  const msg = await loop.runBlock(sid(), 'loop forever');

  expect(called(events)).toHaveLength(2); // capped at the budget
  expect(msg.text).toBe('FALLBACK'); // forced final completion
});

// ── streaming tool loop (runStream) ─────────────────────────────────────────────

test('runStream: tool-call step does not stream as text, final prose IS streamed', async () => {
  const { loop, events } = streamHarness([{ tool: 'test.echo', input: { v: 5 } }, 'the answer is 5'], {
    tools: [echoTool]
  });
  await loop.runStream(sid(), 'hi');

  // The tool-call produced no text tokens; only the prose answer streamed.
  expect(streamedText(events)).toBe('the answer is 5');
  expect(called(events)).toHaveLength(1);
  expect(results(events)[0]?.payload).toMatchObject({ tool: 'test.echo', ok: true });
  const finals = events.filter((e) => e.type === 'session.message.completed');
  expect(finals).toHaveLength(1);
  expect(eventMessage(finals[0])?.text).toBe('the answer is 5');
});

test('runStream: plain prose streams directly with no tool call', async () => {
  const { loop, events } = streamHarness(['hello there'], { tools: [echoTool] });
  await loop.runStream(sid(), 'hi');
  expect(streamedText(events)).toBe('hello there');
});

test('runStream: sandbox guard enforced; tool error surfaced, final answer streamed', async () => {
  const { loop, events } = streamHarness([{ tool: 'file_read', input: { path: '/etc/passwd' } }, 'done'], {
    tools: [fileReadTool],
    sandboxRoots: ['/home/u/workspace']
  });
  await loop.runStream(sid(), 'read it');

  expect(results(events)[0]?.payload).toMatchObject({ ok: false });
  expect(results(events)[0]?.payload.result).toContain('path access denied');
  expect(streamedText(events)).toBe('done');
});

// ── persistence of tool steps ───────────────────────────────────────────────────

test('persists tool steps as tool_call/tool_result rows for history + replay', async () => {
  const { loop, messages } = harness([{ tool: 'test.echo', input: { v: 1 } }, 'final'], { tools: [echoTool] });
  const s = sid();
  await loop.runBlock(s, 'hi');

  const hist = messages.list(s);
  expect(hist.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(hist.map((m) => m.type ?? 'text')).toEqual(['text', 'tool_call', 'tool_result', 'text']);
});

test('collapses persisted tool steps on cross-turn replay (no `tool` role to the model)', async () => {
  const seen: ModelMessage[][] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seen.push(req.messages);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const messages = new InMemoryMessageRepo();
  const s = sid();
  messages.append({
    id: newId('msg'),
    sessionId: s,
    role: 'assistant',
    text: '{"tool":"x"}',
    createdAt: '',
    type: 'tool_call'
  });
  messages.append({
    id: newId('msg'),
    sessionId: s,
    role: 'tool',
    text: 'echoed:1',
    createdAt: '',
    type: 'tool_result'
  });
  const loop = new AgentLoop({ model, tools: [], messages, defaultModel: 'mock', emit: () => {} });

  await loop.runBlock(s, 'hi');
  const prompt = seen[0] as ModelMessage[];
  expect(prompt.some((m) => m.role === 'tool')).toBe(false); // tool-result mapped to a user observation
  expect(prompt.some((m) => m.role === 'assistant' && m.content === '{"tool":"x"}')).toBe(false); // tool_call dropped
  expect(
    prompt.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Observation'))
  ).toBe(true);
});

test('replays persisted tool steps WITH data structurally (native tool-call/tool-result)', async () => {
  const seen: ModelMessage[][] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seen.push(req.messages);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const messages = new InMemoryMessageRepo();
  const s = sid();
  messages.append({
    id: newId('msg'),
    sessionId: s,
    role: 'assistant',
    text: '{"tool":"file_read","input":{"path":"a"}}',
    createdAt: '',
    type: 'tool_call',
    data: { toolCallId: 'tc1', toolName: 'file_read', input: { path: 'a' } }
  });
  messages.append({
    id: newId('msg'),
    sessionId: s,
    role: 'tool',
    text: 'contents of a',
    createdAt: '',
    type: 'tool_result',
    data: { toolCallId: 'tc1', toolName: 'file_read', output: 'contents of a' }
  });
  const loop = new AgentLoop({ model, tools: [], messages, defaultModel: 'mock', emit: () => {} });

  await loop.runBlock(s, 'hi');
  const prompt = seen[0] as ModelMessage[];
  // Structured replay: an assistant tool-call part immediately followed by a tool tool-result part.
  const asst = prompt.find((m) => m.role === 'assistant' && Array.isArray(m.content));
  const toolMsg = prompt.find((m) => m.role === 'tool' && Array.isArray(m.content));
  expect(
    ((asst?.content as ModelContentPart[] | undefined) ?? []).some(
      (p) => p.type === 'tool-call' && p.toolCallId === 'tc1'
    )
  ).toBe(true);
  expect(
    ((toolMsg?.content as ModelContentPart[] | undefined) ?? []).some(
      (p) => p.type === 'tool-result' && p.toolCallId === 'tc1'
    )
  ).toBe(true);
  // Not degraded to a user observation when structured data is present.
  expect(
    prompt.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Observation'))
  ).toBe(false);
});

test('replay uses persisted result.modelContent as the model-facing source of truth', async () => {
  const seen: ModelMessage[][] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seen.push(req.messages);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const messages = new InMemoryMessageRepo();
  const s = sid();
  messages.append({
    id: newId('msg'),
    sessionId: s,
    role: 'assistant',
    text: '{"tool":"file_patch","input":{"path":"a"}}',
    createdAt: '',
    type: 'tool_call',
    data: { toolCallId: 'tc1', toolName: 'file_patch', input: { path: 'a' } }
  });
  messages.append({
    id: newId('msg'),
    sessionId: s,
    role: 'tool',
    text: 'legacy output',
    createdAt: '',
    type: 'tool_result',
    data: {
      toolCallId: 'tc1',
      toolName: 'file_patch',
      output: 'legacy output',
      ok: true,
      result: { modelContent: 'canonical model output', metadata: { changed: true } }
    }
  });
  const loop = new AgentLoop({ model, tools: [], messages, defaultModel: 'mock', emit: () => {} });

  await loop.runBlock(s, 'hi');
  const toolMsg = (seen[0] as ModelMessage[]).find((m) => m.role === 'tool' && Array.isArray(m.content));
  const part = ((toolMsg?.content as ModelContentPart[] | undefined) ?? []).find((p) => p.type === 'tool-result') as
    | { output?: string }
    | undefined;
  expect(part?.output).toBe('canonical model output');
});

test('persistToolStep round-trips structured data for the next turn', async () => {
  const { loop, messages } = harness([{ tool: 'test.echo', input: { v: 7 } }, 'done'], { tools: [echoTool] });
  const s = sid();
  await loop.runBlock(s, 'hi');

  const rows = messages.list(s);
  const callRow = rows.find((m) => m.type === 'tool_call');
  const resultRow = rows.find((m) => m.type === 'tool_result');
  const call = callRow?.data as { toolCallId: string; toolName: string } | undefined;
  const result = resultRow?.data as { toolCallId: string; output: string } | undefined;
  expect(call?.toolName).toBe('test.echo');
  expect(result?.toolCallId).toBe(call?.toolCallId); // call and result share the id (pairable)
});

test('a streaming tool turn persists text↔tool segments as ordered rows (no flattening)', async () => {
  // step 1: preamble text + a tool call; step 2: the final answer text. Each text segment must land
  // as its own row, in order with the tool rows — not collapsed into one assistant message.
  const script: { texts: string[]; call?: { toolCallId: string; toolName: string; input: unknown } }[] = [
    { texts: ['Let me ', 'check.'], call: { toolCallId: 'tc_1', toolName: 'test.echo', input: { v: 1 } } },
    { texts: ['The answer.'] }
  ];
  let i = 0;
  const model: ModelRouter = {
    async *stream() {
      const s = script[i++] ?? { texts: ['fallback'] };
      for (const t of s.texts) yield { type: 'text' as const, token: t };
      if (s.call) yield { type: 'tool-call' as const, call: s.call };
    },
    async complete(): Promise<ModelResult> {
      return { text: '', finishReason: 'stop' };
    }
  };
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({ model, tools: [echoTool], messages, defaultModel: 'mock', emit: () => {} });
  const session = newId('ses') as SessionId;
  await loop.runStream(session, 'go');

  const rows = messages.list(session).map((m) => ({ role: m.role, type: m.type ?? 'text', text: m.text }));
  expect(rows).toEqual([
    { role: 'user', type: 'text', text: 'go' },
    { role: 'assistant', type: 'text', text: 'Let me check.' },
    { role: 'assistant', type: 'tool_call', text: expect.any(String) },
    { role: 'tool', type: 'tool_result', text: expect.any(String) },
    { role: 'assistant', type: 'text', text: 'The answer.' }
  ]);
});

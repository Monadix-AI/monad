import type { Tool, ToolContext, ToolGate, ToolInputSchema } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { fsReadTool, netFetchTool, ToolSecurityError } from '@/capabilities/tools';
import { invokeTool, ToolGateDeniedError, ToolInputError, ToolResultError } from '@/capabilities/tools/invoke.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

const noopLog: ToolContext['log'] = () => {};
const baseOpts = { sessionId: 'sess_1', log: noopLog };

const allowGate: ToolGate = async () => ({ allow: true });
const denyGate: ToolGate = async () => ({ allow: false, reason: 'operator said no' });

/** A safe test tool that echoes the context it received. */
function probeTool(highRisk = false): Tool<{ x: number }, { x: number; ctx: ToolContext }> {
  return {
    name: 'test.probe',
    description: 'echoes input + ctx',
    scopes: [],
    highRisk,
    run: async (input, ctx) => toolResult({ x: input.x, ctx })
  };
}

test('non-high-risk tool runs without a gate', async () => {
  const out = await invokeTool(probeTool(false), { x: 7 }, baseOpts);
  expect(out.metadata.x).toBe(7);
});

test('sandboxRoots is threaded into ToolContext', async () => {
  const out = await invokeTool(probeTool(false), { x: 1 }, { ...baseOpts, sandboxRoots: ['/ws'] });
  expect(out.metadata.ctx.sandboxRoots).toEqual(['/ws']);
  expect(out.metadata.ctx.sessionId).toBe('sess_1');
});

test('high-risk tool with no gate is denied (fail-closed)', async () => {
  await expect(invokeTool(probeTool(true), { x: 1 }, baseOpts)).rejects.toBeInstanceOf(ToolGateDeniedError);
});

test('high-risk tool with an allowing gate runs', async () => {
  const out = await invokeTool(probeTool(true), { x: 9 }, { ...baseOpts, gate: allowGate });
  expect(out.metadata.x).toBe(9);
});

test('high-risk tool denied by the gate throws with the reason', async () => {
  await expect(invokeTool(probeTool(true), { x: 1 }, { ...baseOpts, gate: denyGate })).rejects.toThrow(
    /operator said no/
  );
});

test('the gate receives the correct request', async () => {
  let seen: unknown;
  const spyGate: ToolGate = async (req) => {
    seen = req;
    return { allow: true };
  };
  await invokeTool(probeTool(true), { x: 42 }, { ...baseOpts, gate: spyGate });
  expect(seen).toEqual({ tool: 'test.probe', sessionId: 'sess_1', highRisk: true, input: { x: 42 } });
});

// ── resource guards fire through the dispatcher (defense lives in the tool) ──────

test('fs_read: path traversal is rejected when a sandbox root is set', async () => {
  await expect(
    invokeTool(fsReadTool, { path: '/etc/passwd' }, { ...baseOpts, sandboxRoots: ['/home/u/workspace'] })
  ).rejects.toBeInstanceOf(ToolSecurityError);
});

test('net_fetch: SSRF target is rejected through invokeTool', async () => {
  await expect(invokeTool(netFetchTool, { url: 'http://169.254.169.254/' }, baseOpts)).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

// ── input-schema validation at the dispatch boundary ────────────────────────────

// A coercing schema: accepts a number or a numeric string, normalizes to { n: number }.
const numSchema: ToolInputSchema<{ n: number }> = {
  safeParse(input) {
    const v = (input as { n?: unknown })?.n;
    if (typeof v === 'number') return { success: true, data: { n: v } };
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      return { success: true, data: { n: Number(v) } };
    }
    return { success: false, error: 'n must be numeric' };
  }
};

function schemaTool(highRisk = false): Tool<{ n: number }, number> {
  return {
    name: 'test.num',
    description: 'doubles n',
    scopes: [],
    highRisk,
    inputSchema: numSchema,
    run: async ({ n }) => toolResult(n * 2)
  };
}

test('input schema validates and coerces before run', async () => {
  // Numeric string is coerced to a number, so run() receives { n: 21 } → 42.
  const out = await invokeTool(schemaTool(), { n: '21' } as unknown as { n: number }, baseOpts);
  expect(out.metadata).toBe(42);
});

test('invalid input is rejected with ToolInputError', async () => {
  await expect(invokeTool(schemaTool(), { n: 'abc' } as unknown as { n: number }, baseOpts)).rejects.toBeInstanceOf(
    ToolInputError
  );
});

test('input validation runs before the gate (malformed high-risk call never reaches the gate)', async () => {
  let gateCalls = 0;
  const spyGate: ToolGate = async () => {
    gateCalls++;
    return { allow: true };
  };
  await expect(
    invokeTool(schemaTool(true), { n: {} } as unknown as { n: number }, { ...baseOpts, gate: spyGate })
  ).rejects.toBeInstanceOf(ToolInputError);
  expect(gateCalls).toBe(0);
});

test('builtin fs_read schema rejects a missing path', async () => {
  await expect(
    invokeTool(fsReadTool, {} as unknown as { path: string }, { ...baseOpts, sandboxRoots: ['/ws'] })
  ).rejects.toBeInstanceOf(ToolInputError);
});

test('invalid tool results are rejected at the dispatch boundary', async () => {
  const badTool = {
    name: 'test.bad-result',
    description: 'returns a malformed result',
    scopes: [],
    run: async () => ({ metadata: { ok: true } })
  } as unknown as Tool<Record<string, never>, { ok: boolean }>;

  await expect(invokeTool(badTool, {}, baseOpts)).rejects.toBeInstanceOf(ToolResultError);
});

// ── signal + toolCallId forwarding (ToolContext) ─────────────────────────────────

test('signal and toolCallId are threaded into ToolContext', async () => {
  const controller = new AbortController();
  const out = await invokeTool(
    probeTool(false),
    { x: 1 },
    {
      ...baseOpts,
      signal: controller.signal,
      toolCallId: 'tc_42'
    }
  );
  expect(out.metadata.ctx.toolCallId).toBe('tc_42');
  expect(out.metadata.ctx.signal).toBe(controller.signal);
});

// ── needsApproval predicate (overrides highRisk per-input) ───────────────────────

/** A tool whose approval requirement depends on the input. */
function conditionalTool(): Tool<{ danger: boolean }, string> {
  return {
    name: 'test.conditional',
    description: 'gated only when danger',
    scopes: [],
    needsApproval: (input) => input.danger,
    run: async () => toolResult('ran')
  };
}

test('needsApproval=false runs without a gate even with no gate configured', async () => {
  expect((await invokeTool(conditionalTool(), { danger: false }, baseOpts)).metadata).toBe('ran');
});

test('needsApproval=true requires the gate (denied fail-closed without one)', async () => {
  await expect(invokeTool(conditionalTool(), { danger: true }, baseOpts)).rejects.toBeInstanceOf(ToolGateDeniedError);
});

test('needsApproval=true passes through an allowing gate', async () => {
  expect((await invokeTool(conditionalTool(), { danger: true }, { ...baseOpts, gate: allowGate })).metadata).toBe(
    'ran'
  );
});

test('needsApproval overrides highRisk: a highRisk tool can self-approve a safe input', async () => {
  const tool: Tool<{ x: number }, string> = {
    name: 'test.override',
    description: 'highRisk but conditionally safe',
    scopes: [],
    highRisk: true,
    needsApproval: () => false,
    run: async () => toolResult('ran')
  };
  // highRisk would normally fail-closed without a gate, but needsApproval()=false wins.
  expect((await invokeTool(tool, { x: 1 }, baseOpts)).metadata).toBe('ran');
});

test('backends is threaded into ToolContext.backends', async () => {
  const fakeBackends = { fs: { delegated: true as const }, terminal: { delegated: true as const } } as never;
  const out = await invokeTool(probeTool(false), { x: 1 }, { ...baseOpts, backends: fakeBackends });
  expect(out.metadata.ctx.backends).toBe(fakeBackends);
});

test('onProgress is threaded into ToolContext.reportProgress', async () => {
  const received: string[] = [];
  const out = await invokeTool(probeTool(false), { x: 1 }, { ...baseOpts, onProgress: (s) => received.push(s) });
  expect(out.metadata.ctx.reportProgress).toBeFunction();
  out.metadata.ctx.reportProgress?.('hello');
  expect(received).toEqual(['hello']);
});

test('onProgress absent → reportProgress is undefined', async () => {
  const _out = await invokeTool(probeTool(false), { x: 1 }, baseOpts);
});

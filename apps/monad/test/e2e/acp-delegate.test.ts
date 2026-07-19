// monad as an ACP CLIENT: agent_acp_delegate spawns a registered external ACP agent and drives it
// over stdio. Uses the mock-acp-agent fixture (a real ACP agent peer) — the same wire path monad would
// use to drive codex/claude-code. Covers: result return, unknown-agent rejection, monad-served
// filesystem (containment), the permission round-trip through the gate, and multi-turn delegate reuse.

import type { SessionId } from '@monad/protocol';
import type { ToolContext, ToolGate } from '#/capabilities/tools/types.ts';

import { afterAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import {
  clearAcpDelegatesForSession,
  createAcpDelegateTool,
  directDelegate
} from '#/services/delegation/acp-delegate.ts';

const fixture = resolve(import.meta.dir, '../fixtures/mock-acp-agent.ts');

// Delegates are REUSED per (sessionId, agent) via a module-level registry, so each test needs its own
// session or it would inherit a prior test's live adapter. Default to a fresh session per ctx; the
// reuse/eviction tests pass an explicit shared sessionId. Every session used is torn down after.
let ctxSeq = 0;
const usedSessions = new Set<string>();
function fakeCtx(sandboxRoots?: string[], progress?: string[], sessionId?: string): ToolContext {
  const sid = sessionId ?? `ses_${++ctxSeq}`;
  usedSessions.add(sid);
  return {
    sessionId: sid as SessionId,
    toolCallId: 'tc_1',
    sandboxRoots,
    signal: new AbortController().signal,
    reportProgress: (output: string) => progress?.push(output),
    log: () => {}
  } as unknown as ToolContext;
}

afterAll(() => {
  for (const sid of usedSessions) clearAcpDelegatesForSession(sid); // reap any still-live adapters
});

test('agent_acp_delegate spawns an external ACP agent and returns its answer', async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  const result = await tool.run({ agent: 'mock', instruction: 'do the thing' }, fakeCtx());
  expect(result.metadata.text).toBe('mock-acp handled: do the thing');
});

test('agent_acp_delegate rejects an unknown / disabled agent name', async () => {
  const tool = createAcpDelegateTool({
    agents: [
      { name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false },
      { name: 'off', command: 'bun', args: [fixture], enabled: false, osSandbox: false, forwardMcp: false }
    ]
  });
  await expect(tool.run({ agent: 'nope', instruction: 'x' }, fakeCtx())).rejects.toThrow(/unknown ACP agent/);
  await expect(tool.run({ agent: 'off', instruction: 'x' }, fakeCtx())).rejects.toThrow(/unknown ACP agent/);
});

test("the sub-agent's tool activity surfaces on the parent stream via reportProgress", async () => {
  const progress: string[] = [];
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  const result = await tool.run({ agent: 'mock', instruction: 'toolcall' }, fakeCtx(undefined, progress));
  expect(result.metadata.text).toBe('used a tool'); // the answer excludes the activity log
  expect(progress.join('\n')).toContain('sub-fs-read'); // the sub-agent's tool call was surfaced live
});

test("the sub-agent's plan/checklist surfaces on the parent stream", async () => {
  const progress: string[] = [];
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  const result = await tool.run({ agent: 'mock', instruction: 'plan' }, fakeCtx(undefined, progress));
  expect(result.metadata.text).toBe('planned');
  const log = progress.join('\n');
  expect(log).toContain('investigate the bug');
  expect(log).toContain('write the fix');
});

test('direct ACP chat surfaces non-answer activity separately from the final response', async () => {
  const activity: string[] = [];
  const result = await directDelegate(
    { name: 'mock-direct', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false },
    'plan',
    {
      sessionId: fakeCtx().sessionId,
      signal: new AbortController().signal,
      onActivity: (output) => activity.push(output)
    }
  );

  expect(result).toBe('planned');
  expect(activity.join('\n')).toContain('investigate the bug');
  expect(activity.join('\n')).not.toContain('planned');
});

test('direct ACP chat streams agent message chunks', async () => {
  const chunks: string[] = [];
  const result = await directDelegate(
    { name: 'mock-stream', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false },
    'stream this',
    {
      sessionId: fakeCtx().sessionId,
      signal: new AbortController().signal,
      onChunk: (delta) => chunks.push(delta)
    }
  );

  expect(result).toBe('mock-acp handled: stream this');
  expect(chunks.join('')).toBe(result);
});

test("the sub-agent's permission request routes through monad's oversight gate (deny → rejected)", async () => {
  const denyGate: ToolGate = async () => ({ allow: false, reason: 'nope' });
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }],
    gate: denyGate
  });
  const result = await tool.run({ agent: 'mock', instruction: 'perm' }, fakeCtx());
  expect(result.metadata.text).toBe('perm: reject');
});

test("the sub-agent's permission request is allowed when the gate allows", async () => {
  const allowGate: ToolGate = async () => ({ allow: true });
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }],
    gate: allowGate
  });
  const result = await tool.run({ agent: 'mock', instruction: 'perm' }, fakeCtx());
  expect(result.metadata.text).toBe('perm: allow');
});

test('a missing adapter command fails with an actionable message, not a bare ENOENT', async () => {
  const tool = createAcpDelegateTool({
    agents: [
      {
        name: 'mock',
        command: 'definitely-not-a-real-binary-xyz',
        args: [],
        enabled: true,
        osSandbox: false,
        forwardMcp: false
      }
    ]
  });
  await expect(tool.run({ agent: 'mock', instruction: 'x' }, fakeCtx())).rejects.toThrow(
    /could not start MeshAgent "mock".*installed and on PATH/s
  );
});

test('an adapter that exits before the ACP handshake fails with a clear error (not a hang)', async () => {
  const tool = createAcpDelegateTool({
    // bun starts, exits 1 immediately, never speaks ACP → handshake must fail fast, not wait out the timeout
    agents: [
      {
        name: 'mock',
        command: 'bun',
        args: ['-e', 'process.exit(1)'],
        enabled: true,
        osSandbox: false,
        forwardMcp: false
      }
    ]
  });
  await expect(tool.run({ agent: 'mock', instruction: 'x' }, fakeCtx())).rejects.toThrow(
    /failed to run MeshAgent "mock"/
  );
});

test('a follow-up delegation REUSES the live (session, agent) delegate — same process, continued session', async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  const first = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_reuse0000000')
  );
  const second = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_reuse0000000')
  );
  expect(first.metadata.text).toBe('count: 1');
  expect(second.metadata.text).toBe('count: 2'); // same adapter process + same ACP session carried over
  // …and crucially ONE session/new across all turns — proving true continuation, not a re-handshake per
  // prompt (which would also yield count 1→2 but discard the sub-agent's context).
  const sessions = await tool.run(
    { agent: 'mock', instruction: 'sessions' },
    fakeCtx(undefined, undefined, 'ses_reuse0000000')
  );
  expect(sessions.metadata.text).toBe('sessions: 1');
});

test('a different session is an isolated delegate (no cross-session continuation)', async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  await tool.run({ agent: 'mock', instruction: 'count' }, fakeCtx(undefined, undefined, 'ses_isoa00000000'));
  const other = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_isob00000000')
  );
  expect(other.metadata.text).toBe('count: 1'); // a separate session spawned its own adapter, counter starts fresh
});

test('clearing a session evicts its delegate — the next delegation re-spawns fresh', async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  const before = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_evict0000000')
  );
  expect(before.metadata.text).toBe('count: 1'); // fresh session → fresh adapter
  clearAcpDelegatesForSession('ses_evict0000000');
  const after = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_evict0000000')
  );
  expect(after.metadata.text).toBe('count: 1'); // re-spawned after eviction → counter reset
});

test('two CONCURRENT delegations to the same agent share one adapter and serialize (no clobbered turn)', async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  // Fire both before either resolves: pendingSpawns must dedup to ONE adapter, and d.queue must
  // serialize the two prompts so the shared per-turn slot isn't clobbered.
  const [a, b] = await Promise.all([
    tool.run({ agent: 'mock', instruction: 'count' }, fakeCtx(undefined, undefined, 'ses_conc00000000')),
    tool.run({ agent: 'mock', instruction: 'count' }, fakeCtx(undefined, undefined, 'ses_conc00000000'))
  ]);
  // One shared process + serialized turns → the two answers are count 1 and 2 (order not guaranteed),
  // never two 1s (two adapters) or a mangled slot.
  expect([a.metadata.text, b.metadata.text].sort()).toEqual(['count: 1', 'count: 2']);
  const sessions = await tool.run(
    { agent: 'mock', instruction: 'sessions' },
    fakeCtx(undefined, undefined, 'ses_conc00000000')
  );
  expect(sessions.metadata.text).toBe('sessions: 1'); // a single spawn was shared, not one-per-caller
});

test('aborting a turn evicts the reused delegate — the next delegation re-spawns', async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: false }]
  });
  const first = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_abort0000000')
  );
  expect(first.metadata.text).toBe('count: 1');
  // A delegation whose signal is already aborted must kill the reused adapter, not drive it.
  const aborted = new AbortController();
  aborted.abort();
  const abortedCtx = {
    sessionId: 'ses_abort0000000' as SessionId,
    toolCallId: 'tc_1',
    signal: aborted.signal,
    reportProgress: () => {},
    log: () => {}
  } as unknown as ToolContext;
  await expect(tool.run({ agent: 'mock', instruction: 'count' }, abortedCtx)).rejects.toThrow(/aborted/);
  // The abort evicted the delegate, so the next (fresh-signal) call re-spawns → counter resets.
  const after = await tool.run(
    { agent: 'mock', instruction: 'count' },
    fakeCtx(undefined, undefined, 'ses_abort0000000')
  );
  expect(after.metadata.text).toBe('count: 1');
});

test("monad's configured MCP servers are forwarded to the sub-agent's newSession", async () => {
  const tool = createAcpDelegateTool({
    agents: [{ name: 'mock', command: 'bun', args: [fixture], enabled: true, osSandbox: false, forwardMcp: true }],
    mcpServers: [
      { name: 'srv-a', command: 'x', args: [], env: [] },
      { name: 'srv-b', type: 'http', url: 'https://x.test', headers: [] }
    ]
  });
  // The fixture echoes the MCP server names it received via newSession — proving the forward.
  const result = await tool.run({ agent: 'mock', instruction: 'mcp' }, fakeCtx());
  expect(result.metadata.text).toBe('mcp: srv-a,srv-b');
});

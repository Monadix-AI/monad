// Peer federation MVP closed loop: daemon A's agent_peer_delegate tool drives daemon B's real
// OpenAI-compat endpoint (POST /openai/v1/chat/completions) — B runs the subtask on its own
// agent/model and streams the answer back, which becomes A's tool result. The model on B is the
// shared deterministic mock (as in every e2e); everything else is the real wire path: the
// openai-compat controller, session create, sendInline, and SSE streaming.

import type { MonadPaths } from '@monad/home';
import type { Event, SessionId } from '@monad/protocol';
import type { PolicyEngine } from '@/agent/approvals/engine.ts';
import type { ModelRouter } from '@/agent/index.ts';
import type { ToolContext } from '@/capabilities/tools/types.ts';

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';

import { buildSessionOrigin } from '@/handlers/session/origin.ts';
import { ModelService } from '@/handlers/settings/model/index.ts';
import { MOCK_REPLY, mockModel } from '@/infra/mock-model.ts';
import { createPeerDelegateTool, type PeerDelegateTarget } from '@/services/delegation/peer-delegate.ts';
import { OversightService } from '@/services/oversight.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, type LiveApp, makeTestPaths, readSSE, seededProviderRegistry } from '../helpers.ts';

const TOKEN = 'peer-secret-token';

interface PeerDaemon {
  baseUrl: string;
  dir: string;
  stop: () => void;
}

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base, { mcp: join(base, 'atoms', 'mcp'), skillsLock: join(base, 'atoms', 'skills.lock') });
}

// Stand up daemon B over a real temp ~/.monad with its OpenAI-compat API enabled behind a token.
async function startPeerDaemon(): Promise<PeerDaemon> {
  const dir = join(tmpdir(), `monad-peer-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const handlers = buildHandlers(mockModel(), { paths, modelService });
  const app = createHttpTransport(handlers, {
    openaiCompatConfig: () => Promise.resolve({ enabled: true, token: TOKEN })
  }).listen({ hostname: '127.0.0.1', port: 0 }) as unknown as {
    server: { port: number; stop: (force?: boolean) => void };
  };
  return {
    baseUrl: `http://127.0.0.1:${app.server.port}/openai`,
    dir,
    stop: () => app.server.stop(true)
  };
}

function fakeCtx(progress?: string[], signal?: AbortSignal): ToolContext {
  return {
    sessionId: 'ses_A' as SessionId,
    toolCallId: 'tc_1',
    signal: signal ?? new AbortController().signal,
    reportProgress: (output: string) => progress?.push(output),
    log: () => {}
  } as unknown as ToolContext;
}

function target(baseUrl: string, token = TOKEN): PeerDelegateTarget {
  return { id: 'peer_B', label: 'B', baseUrl, defaultAgent: 'default', token };
}

let peer: PeerDaemon;
beforeAll(async () => {
  peer = await startPeerDaemon();
});
afterAll(async () => {
  peer.stop();
  await rm(peer.dir, { recursive: true, force: true });
});

test('closed loop: A delegates to peer B, B answers, the result returns to A', async () => {
  const progress: string[] = [];
  const tool = createPeerDelegateTool({ peers: [target(peer.baseUrl)] });
  const result = await tool.run({ peer: 'B', instruction: 'compute X with your own tools' }, fakeCtx(progress));
  // B's answer (the mock model's reply) is the tool result handed back to A's agent loop.
  expect(result.metadata.text).toBe(MOCK_REPLY);
  // The answer streamed back incrementally — A saw partial output, not just the final blob.
  expect(progress.length).toBeGreaterThan(1);
  expect(progress.at(-1)).toBe(MOCK_REPLY);
});

test('resolves the peer by id as well as label', async () => {
  const tool = createPeerDelegateTool({ peers: [target(peer.baseUrl)] });
  const result = await tool.run({ peer: 'peer_B', instruction: 'hi' }, fakeCtx());
  expect(result.metadata.text).toBe(MOCK_REPLY);
});

test('an unknown peer name is rejected before any network call', async () => {
  const tool = createPeerDelegateTool({ peers: [target(peer.baseUrl)] });
  await expect(tool.run({ peer: 'nope', instruction: 'x' }, fakeCtx())).rejects.toThrow(/unknown peer/);
});

test('a wrong token surfaces the peer 401 without leaking the token', async () => {
  const tool = createPeerDelegateTool({ peers: [target(peer.baseUrl, 'wrong-token')] });
  const err = await tool.run({ peer: 'B', instruction: 'x' }, fakeCtx()).catch((e: unknown) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/401|rejected/);
  expect((err as Error).message).not.toContain('wrong-token');
});

test('an already-aborted signal aborts the delegation', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const tool = createPeerDelegateTool({ peers: [target(peer.baseUrl)] });
  await expect(tool.run({ peer: 'B', instruction: 'x' }, fakeCtx(undefined, ctrl.signal))).rejects.toThrow();
});

// ── full two-daemon interconnect: A's REAL agent loop decides to delegate to B ──────────────
// The tests above drive A's tool directly. Here A is a real daemon too: a scripted model makes A's
// agent loop emit an agent_peer_delegate tool call, the loop runs it (→ B over HTTP), feeds B's
// answer back into the loop, and A produces its final message. Both daemons run their own agent loop.

type Step = string | { tool: string; input: Record<string, unknown> };

// A model whose stream() replays one scripted step per invocation: a string streams as text, an
// object emits a tool call. The agent loop runs the tool then re-invokes the model for the next step.
function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {
      const step = steps[i++];
      if (step === undefined) return;
      if (typeof step === 'string') {
        for (const ch of step) yield { type: 'text' as const, token: ch };
      } else {
        yield { type: 'tool-call' as const, call: { toolCallId: `tc_${i}`, toolName: step.tool, input: step.input } };
      }
    },
    async complete() {
      return { text: '', finishReason: 'stop' as const };
    }
  };
}

// A's gate must allow the high-risk delegate tool unattended; a stub engine that decides 'allow'.
function allowAllOversight(): OversightService {
  const engine = { decide: () => 'allow' } as unknown as PolicyEngine;
  return new OversightService({ publish: () => {}, engine });
}

test("two daemons: A's agent loop delegates to B and answers from B's result", async () => {
  const FINAL = 'Based on the peer, the answer is ready.';
  const oversight = allowAllOversight();
  const peerTool = createPeerDelegateTool({ peers: [target(peer.baseUrl)], gate: oversight.gate });
  const model = scriptedModel([
    { tool: 'agent_peer_delegate', input: { peer: 'B', instruction: 'compute X with your own tools' } },
    FINAL
  ]);
  const handlersA = buildHandlers(model, undefined, { tools: [peerTool], oversight });

  const { sessionId } = await handlersA.session.create({
    title: 'A',
    origin: buildSessionOrigin({ transport: 'http', surface: 'api', client: 'test' })
  });
  const events: Event[] = [];
  await handlersA.session.sendInline({ sessionId, text: 'do it' }, (e) => events.push(e), { transport: 'http' });

  const byType = (t: string) => events.filter((e) => e.type === t).map((e) => e.payload as Record<string, unknown>);
  // A's loop invoked the delegate tool…
  expect(byType('tool.called').some((p) => p.tool === 'agent_peer_delegate')).toBe(true);
  // …B answered, and its reply came back into A's loop as the tool result…
  const result = byType('tool.result').find((p) => p.tool === 'agent_peer_delegate');
  expect(result?.ok).toBe(true);
  expect(String(result?.result)).toContain(MOCK_REPLY);
  // …and A produced its own final message after the delegation completed.
  expect(
    byType('agent.message')
      .map((p) => String(p.text))
      .join('')
  ).toContain(FINAL);
});

// ── HTTP-level two-daemon roundtrip ────────────────────────────────────────────────────────────
// The test above drives A's handlers in-process. Here BOTH A and B are real HTTP servers: the
// client creates a session on A over HTTP, subscribes to A's SSE event stream, sends a message,
// and observes the full chain (client→A HTTP→B HTTP/SSE→A→client SSE) via the wire.

test('HTTP end-to-end: client drives A over HTTP/SSE while A delegates to B over HTTP', async () => {
  const FINAL = 'Based on peer result, all done via HTTP.';
  const oversight = allowAllOversight();
  const peerTool = createPeerDelegateTool({ peers: [target(peer.baseUrl)], gate: oversight.gate });
  const model = scriptedModel([{ tool: 'agent_peer_delegate', input: { peer: 'B', instruction: 'compute X' } }, FINAL]);

  // Mount Daemon A on a real TCP loopback port — this is the only part not covered by the test above.
  const liveA = createHttpTransport(buildHandlers(model, undefined, { tools: [peerTool], oversight })).listen({
    hostname: '127.0.0.1',
    port: 0
  }) as unknown as LiveApp;
  const baseA = `http://127.0.0.1:${liveA.server.port}`;

  try {
    // Create a session on A via HTTP.
    const sessionRes = await fetch(`${baseA}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'http-chain' })
    });
    if (!sessionRes.ok) throw new Error(`session create failed: HTTP ${sessionRes.status}`);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // Subscribe to A's SSE event stream before sending so no events are missed.
    // onConnected fires once the server has accepted the connection (response headers received),
    // so we can safely send the message without a fixed sleep.
    let sseReady!: () => void;
    const readyP = new Promise<void>((resolve) => {
      sseReady = resolve;
    });
    const eventsP = readSSE(`${baseA}/v1/sessions/${sessionId}/events`, {
      until: (e) => e.type === 'agent.message',
      timeoutMs: 10_000,
      onConnected: sseReady
    });
    await readyP;

    // Send the user message to A over HTTP — A's agent loop will run and delegate to B.
    const msgRes = await fetch(`${baseA}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'do it' })
    });
    if (!msgRes.ok) throw new Error(`message send failed: HTTP ${msgRes.status}`);

    const events = await eventsP;
    const byType = (t: string) => events.filter((e) => e.type === t).map((e) => e.payload as Record<string, unknown>);

    // A's HTTP layer routed the message to the agent loop, which called the delegate tool…
    expect(byType('tool.called').some((p) => p.tool === 'agent_peer_delegate')).toBe(true);
    // …B answered over HTTP/SSE, and the result came back through A's loop…
    const result = byType('tool.result').find((p) => p.tool === 'agent_peer_delegate');
    expect(result?.ok).toBe(true);
    expect(String(result?.result)).toContain(MOCK_REPLY);
    // …and A's final answer arrived over SSE to the client.
    expect(
      byType('agent.message')
        .map((p) => String(p.text))
        .join('')
    ).toContain(FINAL);
  } finally {
    liveA.server.stop(true);
  }
});

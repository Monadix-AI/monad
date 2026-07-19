import type { ClientConnection, McpServer } from '@agentclientprotocol/sdk';
import type { AcpAgentConfig } from '@monad/environment';
import type { ToolContext, ToolGate } from '#/capabilities/tools/types.ts';
import type { LiveDelegate } from './acp-delegate-types.ts';

import { ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createLogger } from '@monad/logger';

import { buildSandboxPolicy, createSandboxBackends, sandboxedSpawn, sandboxLauncher } from '#/capabilities/tools';
import { tryResolveSecretMap } from '#/config/secrets.ts';
import { daemonChildProcesses, killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';
import { buildDelegateApp } from './acp-delegate-app.ts';
import { adapterSpawnEnv } from './acp-env.ts';
import { adapterFailureError } from './acp-errors.ts';
import {
  DelegateEvictedError,
  delegateKey,
  delegateStore,
  evictDelegate,
  isAlive,
  liveDelegates,
  pendingSpawns
} from './acp-registry.ts';

const log = createLogger('acp-delegate');

// Backstop for the ACP handshake (initialize + newSession). A missing/crashing/non-ACP adapter leaves
// initialize() awaiting a reply that never arrives, which would hang the parent turn forever; this cap
// turns that into a clear error. It guards ONLY the handshake — the prompt that follows may legitimately
// run long and is bounded instead by the caller's abort signal.
const HANDSHAKE_TIMEOUT_MS = 60_000;

// Evict a reused delegate after this much idle time so an abandoned conversation doesn't keep a
// third-party adapter (and any MCP child processes it spawned) resident forever.
const DELEGATE_IDLE_MS = 5 * 60_000;

/** Spawn an external ACP adapter and complete the handshake (initialize + newSession), returning a live
 *  delegate ready to be prompted. Does NOT run a prompt. Throws (registering nothing) on spawn or
 *  handshake failure. */
async function spawnDelegate(
  key: string,
  spec: AcpAgentConfig,
  ctx: ToolContext,
  mcpServers: McpServer[]
): Promise<LiveDelegate> {
  // The delegated sub-agent is a NEW top-level session, not a continuation of whatever launched monad —
  // strip the session markers it must not inherit (see STRIPPED_CHILD_ENV) from the env.
  // Best-effort: silently skip unresolvable secret refs (e.g. ${env:ANTHROPIC_API_KEY} when unset)
  // so the adapter can fall back to its own credential discovery (~/.claude, ~/.codex, etc.).
  const { env, credentialDirs } = adapterSpawnEnv(spec, { ...Bun.env, ...tryResolveSecretMap(spec.env) });

  // Opt-in double containment beyond ACP's capability-level interception: when osSandbox is set, the
  // adapter PROCESS is also OS-jailed to the session roots. Warn when requested but no launcher is
  // armed, since sandboxedSpawn then passes through (see adapterSpawnEnv + the daemon-wide config note).
  if (spec.osSandbox === true && sandboxLauncher().kind === 'none') {
    log.warn(
      { agent: spec.name },
      'osSandbox requested but no OS sandbox launcher is armed (agent.sandbox.confine is off) — the adapter runs unconfined'
    );
  }
  // Bun.spawn throws synchronously when the program isn't found (e.g. `npx` not on PATH) — turn that
  // into an actionable message instead of a bare ENOENT bubbling up to the model.
  const proc = (() => {
    try {
      return sandboxedSpawn(
        [spec.command, ...(spec.args ?? [])],
        {
          cwd: spec.cwd ?? ctx.sandboxRoots?.[0],
          env,
          detached: true,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'inherit' // the sub-agent's logs pass through to the daemon's stderr
        },
        buildSandboxPolicy(ctx.sandboxRoots, credentialDirs),
        { confine: spec.osSandbox === true }
      );
    } catch (err) {
      throw new Error(
        `could not start MeshAgent "${spec.name}" (command "${spec.command}"): ${err instanceof Error ? err.message : String(err)} — is it installed and on PATH?`
      );
    }
  })();
  daemonChildProcesses.track(proc.pid, `acp-delegate:${spec.name}`);
  void proc.exited.then(() => daemonChildProcesses.untrack(proc.pid));

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    }
  });

  const d: LiveDelegate = {
    spec,
    proc,
    conn: undefined as unknown as ClientConnection, // set on the next line (handlers need `d`)
    acpSessionId: '',
    terminals: new Map(),
    termSeq: 0,
    turn: null,
    idleTimer: null,
    queue: Promise.resolve(),
    reuseCount: 0,
    promptCount: 0
  };
  d.conn = buildDelegateApp(d).connect(ndJsonStream(output, proc.stdout));

  // If the adapter dies on its own (crash, OOM, killed externally), tear the delegate down FULLY (abort
  // its terminals, close the conn, drop it) so the next delegation re-spawns instead of reusing a dead
  // connection. Identity-guarded so a re-spawn that already replaced this proc under the same key is left
  // untouched; evictDelegate's proc.kill() is a harmless no-op on the already-dead proc.
  void proc.exited.then((code) => {
    if (liveDelegates.get(key)?.proc === proc) evictDelegate(key, 'adapter exited');
    log.debug({ agent: spec.name, code }, 'external ACP adapter exited');
  });

  // Kill the adapter if the handshake stalls, so a hung initialize/newSession can't wedge the turn.
  let handshakeTimedOut = false;
  const handshakeTimer = setTimeout(() => {
    handshakeTimedOut = true;
    killDaemonProcessTree(proc.pid);
  }, HANDSHAKE_TIMEOUT_MS);
  try {
    // Advertise fs + terminal so the sub-agent routes file ops AND shell through monad (served above).
    const init = await d.conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
    });
    // Only forward http MCP servers to adapters that advertise http MCP support (stdio is baseline); a
    // stdio-only adapter (e.g. codex-acp) would otherwise reject newSession or silently drop them.
    const httpOk = init.agentCapabilities?.mcpCapabilities?.http === true;
    const forwarded = httpOk ? mcpServers : mcpServers.filter((s) => !('type' in s && s.type === 'http'));
    if (forwarded.length !== mcpServers.length) {
      log.debug({ agent: spec.name }, 'adapter lacks http MCP capability — forwarding stdio MCP servers only');
    }
    const { sessionId } = await d.conn.agent.request('session/new', {
      cwd: spec.cwd ?? ctx.sandboxRoots?.[0] ?? process.cwd(),
      // Forward monad's configured MCP servers so the sub-agent shares the same external tools.
      mcpServers: forwarded
    });
    d.acpSessionId = sessionId;
    const now = new Date().toISOString();
    try {
      delegateStore?.upsertAcpDelegate({
        id: key,
        sessionId: ctx.sessionId,
        agentName: spec.name,
        acpSessionId: sessionId,
        pid: proc.pid ?? 0,
        spawnedAt: now,
        lastUsedAt: now
      });
    } catch (err) {
      log.warn({ key, agent: spec.name, err }, 'failed to persist delegate spawn');
    }
    return d;
  } catch (err) {
    try {
      d.conn.close();
    } catch {
      // not yet open
    }
    killDaemonProcessTree(proc.pid);
    if (handshakeTimedOut) {
      throw new Error(
        `MeshAgent "${spec.name}" did not complete the ACP handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s — check it is installed and speaks ACP`
      );
    }
    throw adapterFailureError(spec.name, proc.exitCode, err);
  } finally {
    clearTimeout(handshakeTimer);
  }
}

/** Get the live delegate for (session, agent), spawning + handshaking one if absent or dead. Concurrent
 *  callers for the same key share a single in-flight spawn. */
async function getOrSpawnDelegate(
  key: string,
  spec: AcpAgentConfig,
  ctx: ToolContext,
  mcpServers: McpServer[]
): Promise<LiveDelegate> {
  const existing = liveDelegates.get(key);
  if (existing && isAlive(existing)) return existing;
  if (existing) evictDelegate(key, 'stale connection');

  let pending = pendingSpawns.get(key);
  if (!pending) {
    pending = spawnDelegate(key, spec, ctx, mcpServers)
      .then((d) => {
        liveDelegates.set(key, d);
        log.debug({ agent: spec.name, session: ctx.sessionId }, 'spawned reusable ACP delegate');
        return d;
      })
      .finally(() => pendingSpawns.delete(key));
    pendingSpawns.set(key, pending);
  }
  const d = await pending;
  // Count reuses: every getOrSpawn that finds an already-live delegate (i.e. not the first spawn)
  // increments reuseCount so the persisted row tracks how many turns were continued vs fresh spawns.
  if (liveDelegates.get(key) === d && d.promptCount > 0) d.reuseCount++;
  return d;
}

/** Drive one prompt on a live delegate to completion, returning its accumulated answer. Sets the
 *  per-turn slot the builder handlers read; tears the delegate down on abort or failure. */
async function promptDelegate(
  d: LiveDelegate,
  key: string,
  instruction: string,
  ctx: ToolContext,
  gate: ToolGate | undefined,
  onChunk?: (delta: string) => void,
  onActivity?: (activity: string) => void
): Promise<string> {
  // This prompt may have waited in the queue behind earlier ones; a concurrent abort or an adapter exit
  // could have evicted the delegate while it waited. Bail BEFORE touching the connection: surface the
  // abort to the caller, or signal runMeshAgent to re-spawn — never drive a dead connection.
  if (ctx.signal?.aborted) {
    evictDelegate(key, 'aborted before prompt');
    throw new Error(`delegation to "${d.spec.name}" aborted`);
  }
  if (liveDelegates.get(key) !== d || !isAlive(d)) {
    throw new DelegateEvictedError(`delegate for "${d.spec.name}" evicted before its turn ran`);
  }
  if (d.idleTimer) {
    clearTimeout(d.idleTimer);
    d.idleTimer = null;
  }
  // The session's delegating backend if present (so a bridged editor session delegating onward routes
  // the sub-agent's files/shell to the editor too), else a sandbox scoped to the session roots. When
  // the bound agent declares its own working folder (spec.cwd) it leads the roots, so monad-serviced
  // fs/terminal requests from that agent reach it (and use it as the default cwd), not only the parent
  // session's folder — keeping the monad sandbox consistent with the cwd the adapter was spawned in.
  const delegateRoots = d.spec.cwd ? [d.spec.cwd, ...(ctx.sandboxRoots ?? [])] : ctx.sandboxRoots;
  const backends = ctx.backends ?? createSandboxBackends(delegateRoots);
  d.turn = { ctx, gate, backends, result: '', activity: '', processActivity: '', onChunk, onActivity };

  // A turn abort (stop button / session cancel) kills the adapter and evicts the delegate; the next
  // delegation re-spawns. Deliberately simpler than ACP session/cancel, which depends on the adapter
  // honouring it and could leave the prompt awaiting after the parent turn already moved on.
  const onAbort = (): void => evictDelegate(key, 'turn aborted');
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await d.conn.agent.request('session/prompt', {
      sessionId: d.acpSessionId,
      prompt: [{ type: 'text', text: instruction }]
    });
    d.promptCount++;
    return d.turn.result;
  } catch (err) {
    if (ctx.signal?.aborted) {
      // user/session cancelled — kill the adapter and surface the original abort. evictDelegate is
      // idempotent: onAbort may already have run, or may never have (if the signal pre-dated the listener).
      evictDelegate(key, 'turn aborted');
      throw err;
    }
    evictDelegate(key, 'prompt failed'); // the connection may be wedged — don't reuse it
    throw adapterFailureError(d.spec.name, d.proc.exitCode, err);
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
    d.turn = null;
    // Drop any terminals the sub-agent left open this turn; arm the idle clock if still registered.
    for (const t of d.terminals.values()) t.abort.abort();
    d.terminals.clear();
    if (liveDelegates.get(key) === d && isAlive(d)) {
      const now = new Date().toISOString();
      try {
        const updated = delegateStore?.touchAcpDelegate(key, now, d.reuseCount, d.promptCount);
        if (updated === false) log.warn({ key }, 'touchAcpDelegate updated 0 rows — row may have been evicted');
      } catch (err) {
        log.warn({ key, err }, 'failed to persist delegate prompt stats');
      }
      const timer = setTimeout(() => evictDelegate(key, 'idle'), DELEGATE_IDLE_MS);
      timer.unref?.(); // an idle delegate must not keep the daemon's event loop alive
      d.idleTimer = timer;
    }
  }
}

/** Delegate one instruction to an external ACP agent, REUSING a live (session, agent) delegate when one
 *  exists so follow-ups continue the sub-agent's conversation. Returns its accumulated final text. */
export async function runMeshAgent(
  spec: AcpAgentConfig,
  instruction: string,
  ctx: ToolContext,
  gate: ToolGate | undefined,
  mcpServers: McpServer[],
  onChunk?: (delta: string) => void,
  onActivity?: (activity: string) => void
): Promise<string> {
  const key = delegateKey(ctx.sessionId, spec.name);
  log.debug({ sessionId: ctx.sessionId, event: 'acp.prompt.start', agent: spec.name, instruction }, 'acp prompt start');
  // Two attempts at most: a delegate can be evicted between get-or-spawn and the queued prompt actually
  // running (a concurrent delegation to the same agent aborted, or the adapter exited). On that specific
  // signal, re-spawn a fresh delegate once. Any other failure — or our own abort — surfaces immediately.
  for (let attempt = 0; ; attempt++) {
    const d = await getOrSpawnDelegate(key, spec, ctx, mcpServers);
    // Serialize prompts to the same delegate: parallel tool calls to one agent in one session would
    // otherwise clobber the single per-turn slot. Chain each prompt on the delegate's queue.
    const run = d.queue.then(() =>
      promptDelegate(
        d,
        key,
        instruction,
        ctx,
        gate,
        onChunk
          ? (delta) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.chunk', agent: spec.name, delta },
                'acp prompt chunk'
              );
              onChunk(delta);
            }
          : (delta) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.chunk', agent: spec.name, delta },
                'acp prompt chunk'
              );
            },
        onActivity
          ? (activity) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.activity', agent: spec.name, activity },
                'acp prompt activity'
              );
              onActivity(activity);
            }
          : (activity) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.activity', agent: spec.name, activity },
                'acp prompt activity'
              );
            }
      )
    );
    d.queue = run.then(
      () => undefined,
      () => undefined
    );
    try {
      const result = await run;
      log.debug(
        { sessionId: ctx.sessionId, event: 'acp.prompt.result', agent: spec.name, result },
        'acp prompt result'
      );
      return result;
    } catch (err) {
      if (err instanceof DelegateEvictedError && attempt === 0) continue; // re-spawn and retry once
      log.debug(
        {
          sessionId: ctx.sessionId,
          event: 'acp.prompt.error',
          agent: spec.name,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
        },
        'acp prompt error'
      );
      throw err;
    }
  }
}

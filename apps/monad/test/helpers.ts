// Shared test harness: builds a daemon handlers + HTTP app wired to a deterministic
// mock model (no network), plus a tiny SSE reader for the event stream.

import type { MonadPaths } from '@monad/home';
import type {
  Event,
  Hooks,
  SessionId,
  SkillListInstance,
  SkillListItem,
  WorkspaceExperienceDefinition
} from '@monad/protocol';
import type { WorkspaceExperienceApiHandler } from '@monad/sdk-atom';
import type { PolicyEngine } from '@/agent/approvals/engine.ts';
import type { ModelRouter } from '@/agent/index.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';
import { BUILTIN_COMMANDS } from '@monad/atoms/commands/builtins';
import { builtinModelProviders } from '@monad/atoms/providers/registry';
import { createDefaultConfig } from '@monad/home';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { ModelProviderType, newId } from '@monad/protocol';

import { createAgent, ModelProviderRegistry } from '@/agent/index.ts';
import { createClarifyTool } from '@/capabilities/tools/registry/clarify.ts';
import { ChannelService } from '@/channels/channel.ts';
import { type CommandBundle, type CommandRegistry, createCommandRegistry } from '@/handlers/commands/index.ts';
import { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';
import { type ModelDeps, ModelService } from '@/handlers/settings/model/index.ts';
// Deterministic mock model lives in the runtime module so the daemon (--mock-model)
// and tests share one implementation.
import { mockModel } from '@/infra/mock-model.ts';
import { DelegationService } from '@/services/delegation/delegation.ts';
import { EventBus } from '@/services/event-bus.ts';
import { registerAgentAdapterImpl } from '@/services/external-agent/index.ts';
import { ClarifyService } from '@/services/generation/clarify.ts';
import { I18nService } from '@/services/i18n.ts';
import { GraphStore } from '@/services/memory/graph/store.ts';
import { createMemoryService, type MemoryService } from '@/services/memory/index.ts';
import { ModelCatalogService } from '@/services/model-catalog.ts';
import { OversightService } from '@/services/oversight.ts';
import { RoundCache } from '@/services/round-cache.ts';
import { createStore } from '@/store/db/index.ts';
import { createHttpTransport } from '@/transports/http.ts';

// Production populates the external agent adapter registry at boot via the gated atom-pack path
// (onAgentAdapter → registerAgentAdapterImpl); this harness builds handlers directly, so register the
// built-in agent-adapter atoms once for every daemon e2e that drives external agent runtimes.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

export { mockModel };

/** A provider registry pre-seeded with the first-party providers. The daemon fills its registry by
 *  loading `builtinAtomPack` through the gated loader; tests that construct a bare ModelService skip
 *  that and seed directly here (white-box test reach into @monad/atoms is fine). */
export function seededProviderRegistry(): ModelProviderRegistry {
  const registry = new ModelProviderRegistry();
  for (const provider of builtinModelProviders) registry.register(provider);
  return registry;
}

/** A command registry pre-seeded with the first-party built-ins. The daemon seeds its registry by
 *  loading `builtinAtomPack`'s `command` atoms through the gated loader; tests that exercise built-in
 *  commands (or their reserved-name protection) without the loader seed directly here. */
export function seededCommandRegistry(log?: Parameters<typeof createCommandRegistry>[0]): CommandRegistry {
  const registry = createCommandRegistry(log);
  for (const def of BUILTIN_COMMANDS) registry.registerBuiltin(def);
  return registry;
}

// A flat MonadPaths under one throwaway `base` dir for daemon e2e/handler tests (everything nested
// directly, locales/mcp stubbed). One source so a new MonadPaths field doesn't mean editing every
// test that spins a daemon — pass `overrides` for the few fields a given test needs elsewhere.
export function makeTestPaths(base: string, overrides?: Partial<MonadPaths>): MonadPaths {
  return {
    home: base,
    runtime: base,
    configs: base,
    config: join(base, 'config.json'),
    profile: join(base, 'profile.json'),
    approvals: join(base, 'approvals.json'),
    credentials: join(base, 'credentials'),
    auth: join(base, 'credentials', 'auth.json'),
    tls: join(base, 'credentials', 'tls'),
    workspace: join(base, 'workspace'),
    providers: join(base, 'providers'),
    skills: join(base, 'skills'),
    skillsLock: join(base, 'skills.lock'),
    locales: '/dev/null',
    mcp: '/dev/null',
    atoms: join(base, 'atoms'),
    packs: join(base, 'atoms', 'packs'),
    agents: join(base, 'agents'),
    memory: join(base, 'memory'),
    backup: join(base, 'backup'),
    cache: join(base, 'cache'),
    logs: join(base, 'logs'),
    bin: join(base, 'bin'),
    dbDir: base,
    db: join(base, 'monad.sqlite'),
    sock: join(base, 'monad.sock'),
    kvSock: join(base, 'kv.sock'),
    pid: join(base, 'monad.pid'),
    ...overrides
  };
}

// A memory service over a throwaway dir + no-op extractor (the model is never called in handler
// tests; observe only runs on the Stop hook, which these tests don't drive).
export function stubMemoryService(store: ReturnType<typeof createStore>): MemoryService {
  const router: ModelRouter = {
    stream: () => (async function* () {})(),
    complete: async () => ({ text: '' })
  };
  return createMemoryService({
    store,
    root: join(tmpdir(), 'monad-test-memory', newId('ses')),
    dbRoot: join(tmpdir(), 'monad-test-db', newId('ses')),
    router,
    extractModel: () => 'test',
    backend: () => 'builtin',
    mem0Models: () => ({ llm: null, embedder: null, dim: null, error: 'test' }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  });
}

/** Minimal ModelDeps that doesn't need a real home directory. */
export function stubModelDeps(): ModelDeps {
  const paths: MonadPaths = {
    home: '/dev/null',
    runtime: '/dev/null',
    configs: '/dev/null',
    dbDir: '/dev/null',
    db: '/dev/null',
    // No real config paths — lifecycle handler treats missing config as "no agents yet"
    config: '/dev/null/config.json',
    profile: '/dev/null/profile.json',
    approvals: '/dev/null/approvals.json',
    credentials: '/dev/null/credentials',
    auth: '/dev/null/credentials/auth.json',
    tls: '/dev/null/credentials/tls',
    workspace: '/dev/null',
    providers: '/dev/null',
    skills: '/dev/null',
    skillsLock: '/dev/null/skills.lock',
    locales: '/dev/null',
    mcp: '/dev/null',
    atoms: '/dev/null',
    packs: '/dev/null',
    agents: '/dev/null',
    memory: '/dev/null',
    backup: '/dev/null',
    cache: '/dev/null',
    bin: '/dev/null',
    sock: '/dev/null/monad.sock',
    kvSock: '/dev/null/kv.sock',
    pid: '/dev/null/monad.pid',
    logs: '/dev/null/daemon.log'
  };
  const cfg = createDefaultConfig('prn_stub', 'stub');
  return {
    paths,
    modelService: new ModelService('/dev/null/auth.json', cfg, null, seededProviderRegistry()),
    // Empty catalog (no cache loaded, never refreshed) — price lookups just return undefined.
    modelCatalog: new ModelCatalogService({ cachePath: '/dev/null/model-catalog.json', log: () => {} })
  };
}

export function buildHandlers(
  modelRouter: ModelRouter,
  modelDeps: ModelDeps = stubModelDeps(),
  opts?: {
    tools?: Tool[];
    skills?: SkillListItem[];
    skillInstances?: SkillListInstance[];
    clarifyTool?: boolean;
    hooks?: Hooks;
    hookCwd?: string;
    /** Inject a pre-built oversight (e.g. wired with a PolicyEngine) to exercise the approval
     *  allowlist end to end. Defaults to a plain memory-less gate (today's behaviour). */
    oversight?: OversightService;
    /** Wire a PolicyEngine into the DEFAULT oversight (so remembered allow/deny rules apply) while
     *  keeping its `publish` bound to the handlers' own event bus — the approval events still reach
     *  the SSE/WS stream. Ignored when `oversight` is supplied. */
    engine?: PolicyEngine;
    /** Override the default oversight approval timeout (ms). Ignored when `oversight` is supplied. */
    oversightTimeoutMs?: number;
    /** Model spec the agent uses when a request names none. Defaults to 'mock' for the in-process
     *  mock model; a real-router suite passes its profile alias (e.g. 'default'). */
    defaultModel?: string;
    /** Per-session tool exposure filter (Studio per-agent atoms enforcement). */
    agentToolFilter?: (sessionId: string) => ((toolName: string) => boolean) | undefined;
    /** Per-session sandbox roots (Studio per-agent sandbox enforcement). */
    agentSandboxRoots?: (sessionId: string) => string[] | undefined;
    /** Override the memory service (e.g. a mem0-backed one) — defaults to the built-in stub. */
    memoryService?: (store: ReturnType<typeof createStore>) => MemoryService;
    /** Share an external store (so a memory service + the agent see the same messages/sessions). */
    store?: ReturnType<typeof createStore>;
    /** Inject a RoundCache so a test can stage an in-flight round before subscribing. */
    cache?: RoundCache;
    /** Seed the L2 graph store (e.g. to exercise GET /v1/graph); defaults to an empty in-memory one. */
    graphStore?: GraphStore;
    /** Upgrade metadata exposed by /health; defaults to absent. */
    getUpgradeInfo?: () => { latestVersion: string; latestVersionCheckedAt: string } | null;
    /** Override external agent auth connect heartbeat pruning for fast e2e coverage. */
    externalAgentAuthHeartbeatTimeoutMs?: number;
    /** Override the loopback URL injected into managed external agent runtimes. */
    externalAgentServerUrl?: string;
    /** Dynamic workspace experience API route resolver for atom HTTP tests. */
    getWorkspaceExperienceApiHandler?: (
      experienceId: string,
      method: string,
      path: string
    ) => WorkspaceExperienceApiHandler | undefined;
    /** Dynamic workspace experience descriptors for atom HTTP tests. */
    getWorkspaceExperiences?: () => WorkspaceExperienceDefinition[];
  }
) {
  const store = opts?.store ?? createStore();
  // Wire oversight like the daemon (publish → bus, gate → agent) so the approval flow — including
  // the ACP permission bridge — actually exercises end to end. With no tools the gate is never hit.
  const bus = new EventBus();
  const cache = opts?.cache ?? new RoundCache();
  const oversight =
    opts?.oversight ??
    new OversightService({
      publish: (e) => bus.publish(e),
      engine: opts?.engine,
      timeoutMs: opts?.oversightTimeoutMs ?? 2_000
    });
  const clarify = new ClarifyService({ publish: (e) => bus.publish(e), timeoutMs: 2_000 });
  const delegation = new DelegationService({ publish: (e) => bus.publish(e), timeoutMs: 2_000 });
  const agent = createAgent({
    model: modelRouter,
    tools: [...(opts?.tools ?? []), ...(opts?.clarifyTool ? [createClarifyTool(clarify.ask)] : [])],
    gate: oversight.gate,
    hooks: opts?.hooks,
    sessionRepo: {
      insertSession: (s) => store.insertSession(s),
      getSession: (id) => store.getSession(id)
    },
    messageRepo: {
      list: (sessionId) => store.listMessages(sessionId),
      append: (m) => store.insertMessage(m.id, m.transcriptTargetId, m.text, m.createdAt, m.role)
    },
    defaultModel: opts?.defaultModel ?? 'mock'
  });
  const i18n = new I18nService([{ locale: 'en', name: 'English', messages: i18nMessages }], 'en');
  const channelService = new ChannelService(
    {
      session: { createForPrincipal: async () => ({ sessionId: newId('ses') }), sendInline: async () => {} },
      store,
      registry: new Map(),
      bus,
      t: i18n.t,
      log: { info: () => {}, warn: () => {}, error: () => {} }
    },
    createDefaultConfig('prn_stub', 'stub'),
    { version: 1, activeProvider: null, updatedAt: '', credentialPool: {} }
  );
  // Wire the unified slash-command bundle so commands (/help, /reset, …) dispatch over every
  // transport exactly as the daemon does. Model/compact backends are stubbed — the built-ins
  // exercised in tests don't need them.
  const commands: CommandBundle = {
    registry: seededCommandRegistry(),
    skills: () => [],
    listModels: async () => [],
    setModel: async () => {},
    compact: async () => ({ compacted: 0 }),
    consolidate: async () => ({ level: 1, l1Scopes: 0, nodes: 0, edges: 0, prunedEdges: 0, laws: 0, lawScopes: 0 }),
    explainBelief: async () => ({ matches: [] }),
    checkMemory: async () => ({ flagged: 0 }),
    handoff: async () => ({ sessionId: 'ses_new' as SessionId }),
    t: i18n.t,
    log: () => {}
  };
  // Expose `store` (handlers have no such key) so tests that need to drive the background
  // embedding indexer directly can reach the same DB the handlers write to.
  return Object.assign(
    createDaemonHandlers({
      store,
      agent,
      bus,
      cache,
      ownerPrincipalId: newId('prn'),
      oversight,
      clarify,
      delegation,
      channelService,
      localeService: i18n,
      skills: opts?.skills ?? [],
      skillInstances: opts?.skillInstances,
      commands,
      hooks: opts?.hooks,
      hookCwd: opts?.hookCwd,
      agentToolFilter: opts?.agentToolFilter,
      agentSandboxRoots: opts?.agentSandboxRoots,
      memoryService: opts?.memoryService?.(store) ?? stubMemoryService(store),
      graphStore: opts?.graphStore ?? new GraphStore(':memory:'),
      getMem0Data: async () => ({
        available: false,
        vectorStore: 'memory',
        qdrant: null,
        total: 0,
        scopeCounts: [],
        entries: []
      }),
      getLaws: async () => ({ laws: [] }),
      getUpgradeInfo: opts?.getUpgradeInfo,
      getWorkspaceExperienceApiHandler: opts?.getWorkspaceExperienceApiHandler,
      getWorkspaceExperiences: opts?.getWorkspaceExperiences,
      memorySetBackend: async () => {},
      memorySetMem0Models: async () => {},
      memorySetGraph: async () => {},
      externalAgentAuthHeartbeatTimeoutMs: opts?.externalAgentAuthHeartbeatTimeoutMs,
      externalAgentServerUrl: opts?.externalAgentServerUrl,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      ...modelDeps
    }),
    { store, cache, bus }
  );
}

export type LiveApp = { server: { port: number; stop: (force?: boolean) => void } };
type UnixServer = { stop: (force?: boolean) => void };

export function listen(model: ModelRouter): { base: string; stop: () => void } {
  const app = createHttpTransport(buildHandlers(model)).listen({
    hostname: '127.0.0.1',
    port: 0
  }) as unknown as LiveApp;
  return {
    base: `http://127.0.0.1:${app.server.port}`,
    stop: () => app.server.stop(true)
  };
}

export type TransportKind = 'tcp' | 'unix';

// Every apps/monad REST/SSE feature must behave identically over both transports the daemon
// serves (docs/runtime.md). Looping a suite over TRANSPORTS and driving it through the uniform
// fetch/sse below is how we hold that line. WebSocket push (/v1/stream) is TCP-only — Bun's WS
// client can't dial a unix socket — so WS suites stay TCP and are not run here.
// Unix sockets are not supported by Bun on Windows; only run unix transport tests on unix-like OSes.
export const TRANSPORTS: readonly TransportKind[] = process.platform === 'win32' ? ['tcp'] : ['tcp', 'unix'];

export interface TransportHandle {
  kind: TransportKind;
  /** TCP base URL when this handle is backed by a TCP listener. */
  baseUrl?: string;
  /** fetch() bound to this transport. `path` is a leading-slash path, e.g. '/v1/sessions'. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Read an SSE stream over this transport (TCP or unix). */
  sse: (
    path: string,
    opts: { headers?: Record<string, string>; until: (e: Event) => boolean; timeoutMs?: number }
  ) => Promise<Event[]>;
  stop: () => Promise<void>;
}

/** Mount an already-built HTTP app on the given transport and return a uniform client. */
export function serveTransport(kind: TransportKind, app: ReturnType<typeof createHttpTransport>): TransportHandle {
  if (kind === 'tcp') {
    const live = app.listen({ hostname: '127.0.0.1', port: 0 }) as unknown as LiveApp;
    const base = `http://127.0.0.1:${live.server.port}`;
    return {
      kind,
      baseUrl: base,
      fetch: (path, init) => fetch(`${base}${path}`, init),
      sse: (path, opts) => readSSE(`${base}${path}`, opts),
      stop: async () => live.server.stop(true)
    };
  }
  // Keep the path short — macOS caps unix socket paths around 104 bytes.
  const sock = join(tmpdir(), `monad-tr-${process.pid}-${Date.now()}.sock`);
  // idleTimeout matches production's Unix-socket bind (apps/monad/src/bootstrap/serve.ts) and
  // Elysia's own Bun adapter default for the TCP listener above — otherwise a legitimately slow
  // request (e.g. the 20s external agent auth-status probe) hits Bun.serve's 10s default here without
  // ever exercising the code path this transport is supposed to test. bun-types omits `idleTimeout`
  // from the unix-socket overload even though the runtime honors it — cast around the type gap.
  const server = Bun.serve({
    unix: sock,
    fetch: (req: Request) => app.handle(req),
    idleTimeout: 30
  } as unknown as Parameters<typeof Bun.serve>[0]) as unknown as UnixServer;
  return {
    kind,
    fetch: (path, init) => fetch(`http://localhost${path}`, { ...init, unix: sock }),
    sse: (path, opts) => readSSE(`http://localhost${path}`, { ...opts, unix: sock }),
    stop: async () => {
      server.stop(true);
      await unlink(sock).catch(() => {});
    }
  };
}

/**
 * Read an SSE event stream until `until(event)` returns true or `timeoutMs` elapses,
 * then abort. Returns every parsed event seen. `headers` can carry Last-Event-ID.
 */
export async function readSSE(
  url: string,
  opts: {
    headers?: Record<string, string>;
    until: (e: Event) => boolean;
    timeoutMs?: number;
    unix?: string;
    /** Called as soon as the server accepts the SSE connection (response headers received). */
    onConnected?: () => void;
  }
): Promise<Event[]> {
  const controller = new AbortController();
  const seen: Event[] = [];
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2000);

  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal, unix: opts.unix });
    opts.onConnected?.();
    const reader = res.body?.getReader();
    if (!reader) return seen;
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          const event = JSON.parse(dataLine.slice(6)) as Event;
          seen.push(event);
          if (opts.until(event)) {
            controller.abort();
            return seen;
          }
        }
        sep = buf.indexOf('\n\n');
      }
    }
  } catch {
    // aborted (timeout or satisfied) — fall through to return what we collected
  } finally {
    clearTimeout(timer);
  }
  return seen;
}

/**
 * Build a real GatewayModelRouter + ModelDeps backed by OpenRouter from an API key, reusing the
 * stub paths and (empty) model catalog so ONLY the model layer is live. Shared by the opt-in live
 * suites (live-model, live-approvals); they pass `defaultModel: 'default'` to buildHandlers so a
 * request that names no model resolves the seeded profile.
 */
export function liveModelDeps(
  apiKey: string,
  modelId: string,
  opts?: { fallbacks?: Array<{ provider: string; modelId: string }> }
): { router: ModelRouter; deps: ModelDeps } {
  const cfg = createDefaultConfig('prn_live', 'live');
  cfg.model.providers = [{ id: 'openrouter', label: 'OpenRouter', type: ModelProviderType.OpenRouter }];
  // `modelId` may be a bogus id and `fallbacks` a working chain — that's how the routing-resilience
  // suite exercises GatewayModelRouter failover.
  cfg.model.profiles = [
    {
      alias: 'default',
      routes: { chat: { provider: 'openrouter', modelId } },
      params: {},
      fallbacks: opts?.fallbacks ?? []
    }
  ];
  cfg.model.default = 'default';
  const auth = {
    version: 1 as const,
    activeProvider: null,
    updatedAt: new Date().toISOString(),
    credentialPool: {
      openrouter: [
        {
          id: newId('cred'),
          label: 'live-e2e',
          authType: 'api_key' as const,
          priority: 0,
          source: 'dev-env' as const,
          accessToken: apiKey,
          lastStatus: 'unknown' as const,
          lastStatusAt: null,
          lastErrorCode: null,
          lastErrorReason: null,
          lastErrorMessage: null,
          lastErrorResetAt: null,
          requestCount: 0
        }
      ]
    }
  };
  const modelService = new ModelService('/dev/null/auth.json', cfg, auth, seededProviderRegistry());
  return { router: modelService.router, deps: { ...stubModelDeps(), modelService } };
}

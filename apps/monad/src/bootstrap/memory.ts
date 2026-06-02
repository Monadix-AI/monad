// Boot phase: the memory subsystem — the auto-memory note store, the layered L1 memory service
// (built-in MD or mem0, with a daemon-managed local qdrant), the L2 knowledge graph + its opt-in
// background consolidation, the read-only mem0 explorer, and the memory settings write-back. Returns
// the handles the rest of startDaemon wires into agents (memory/graph tools), handlers, and commands.
//
// Live config + auth are read via getters so a settings hot-reload (credential change, model swap,
// backend switch) takes effect without rebuilding the service. mem0 selects its LLM + embedder FROM
// that config (no env vars).

import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { MemoryBackendId, SessionId, SetMem0ModelsRequest } from '@monad/protocol';
import type { ModelRouter } from '@/agent/index.ts';
import type { NoteStore } from '@/capabilities/tools/registry/memory.ts';
import type { ConfigBus } from '@/services/config-bus.ts';
import type { GraphConsolidateResult } from '@/services/memory/graph/service.ts';
import type { MemoryHookRegistry } from '@/services/memory/hooks.ts';
import type { MemoryService } from '@/services/memory/index.ts';
import type { Mem0Data } from '@/services/memory/mem0-explorer.ts';
import type { Store } from '@/store/db/index.ts';

import { join } from 'node:path';
import { saveProfile } from '@monad/home';
import { createLogger } from '@monad/logger';

import { renderNotes } from '@/capabilities/tools/registry/memory.ts';
import { resolveAgentModelRole } from '@/config/resolve.ts';
import { consolidateGraph, graphAutoDue } from '@/services/memory/graph/service.ts';
import { GraphStore } from '@/services/memory/graph/store.ts';
import { registerMemoryHooks } from '@/services/memory/hooks.ts';
import { createMemoryService } from '@/services/memory/index.ts';
import { collectMem0Data, fetchQdrantVectors } from '@/services/memory/mem0-explorer.ts';
import { QdrantManager } from '@/services/memory/qdrant.ts';
import { resolveMem0Models } from '@/services/memory/resolve-mem0.ts';

export interface MemorySubsystemDeps {
  store: Store;
  paths: MonadPaths;
  /** Daemon port — qdrant defaults to port+1000 so parallel worktrees don't collide on 6333. */
  port: number;
  /** Agent model router (mock or live), reused for memory extraction + graph consolidation. */
  router: ModelRouter;
  /** The daemon hook registry — memory lifecycle hooks register here. */
  registry: MemoryHookRegistry;
  configBus: ConfigBus;
  /** Live config holder (owned by main.ts), so a settings hot-reload takes effect without rebuild. */
  liveCfg: () => MonadConfig;
  liveAuth: () => MonadAuth | null;
}

export interface MemorySubsystem {
  noteStore: NoteStore;
  memoryService: MemoryService;
  graphStore: GraphStore;
  graphScopesFor: (sessionId: string) => string[];
  runGraphConsolidate: () => Promise<GraphConsolidateResult>;
  getMem0Data: () => Promise<Mem0Data>;
  memorySetBackend: (backend: MemoryBackendId) => Promise<void>;
  memorySetMem0Models: (sel: SetMem0ModelsRequest) => Promise<void>;
}

export function createMemorySubsystem(deps: MemorySubsystemDeps): MemorySubsystem {
  const { store, paths, port, router: agentModel, registry, configBus, liveCfg, liveAuth } = deps;

  // Auto-memory dogfood: the agent saves session notes via the memory_* tools; a built-in
  // UserPromptSubmit hook re-surfaces them every turn (the capture/recall split hooks make clean).
  const noteStore: NoteStore = {
    get: (sid, key) => store.getMemory(sid, key),
    set: (sid, key, value) => store.setMemory(sid, key, value)
  };

  // Persistent mem0 by default: a daemon-managed local qdrant, downloaded on first use (not bundled).
  // An explicit memory.mem0.vectorStore overrides it (incl. `{ provider: 'memory' }` to opt out → in-RAM).
  const qdrantLog = createLogger('qdrant');
  const qdrant = new QdrantManager({
    binDir: join(paths.cache, 'qdrant'),
    dataDir: join(paths.dbDir, 'qdrant'),
    // Default off the daemon's (per-worktree) port so parallel worktrees don't collide on 6333; gRPC binds +1.
    port: liveCfg().memory.mem0.qdrant?.port ?? port + 1000,
    version: liveCfg().memory.mem0.qdrant?.version,
    log: qdrantLog
  });
  process.on('exit', () => void qdrant.stop());

  const memoryService = createMemoryService({
    store,
    root: paths.memory,
    dbRoot: paths.dbDir,
    router: agentModel,
    extractModel: (agentId) => {
      const agentRoles = agentId ? liveCfg().agent.agents.find((a) => a.id === agentId)?.roles : undefined;
      return resolveAgentModelRole(liveCfg().model, agentRoles, 'memory') ?? liveCfg().model.default;
    },
    backend: () => liveCfg().memory.backend,
    mem0Models: () => resolveMem0Models(liveCfg(), liveAuth(), liveCfg().memory.mem0),
    mem0VectorStore: async () => {
      const explicit = liveCfg().memory.mem0.vectorStore;
      if (explicit) return explicit;
      // A qdrant boot failure (no network/disk/port) must not poison mem0 for the whole session — fall
      // back to in-RAM so recall/observe keep working (memories just won't persist until next restart).
      try {
        return { provider: 'qdrant', config: { url: await qdrant.ensureUrl() } };
      } catch (err) {
        qdrantLog.warn(`local qdrant unavailable — mem0 using in-RAM store this session: ${String(err)}`);
        return undefined;
      }
    },
    // Return undefined when user has configured their own vectorStore — UI shows the custom-store note.
    qdrantStatus: () => (liveCfg().memory.mem0.vectorStore ? undefined : qdrant.getStatus()),
    log: createLogger('memory')
  });

  // L2 knowledge graph (manual /consolidate-graph + the graph_explore/graph_node read tools). Its own
  // SQLite under {home}/db; agent-scoped reads.
  const graphLog = createLogger('graph');
  const graphStore = new GraphStore(join(paths.dbDir, 'graph.sqlite'));
  process.on('exit', () => graphStore.close());
  const graphScopesFor = (sessionId: string): string[] => {
    const agentId = store.getSession(sessionId as SessionId)?.agentIds[0];
    return agentId ? [`agent:${agentId}`] : [];
  };
  const runGraphConsolidate = () => {
    let activeIds: Set<string> | null = null; // built once per pass: every live (active) message id
    return consolidateGraph({
      store: graphStore,
      sessions: () => store.listSessions().map((s) => ({ id: s.id, agentId: s.agentIds[0] ?? null })),
      messagesAfter: (sid, after) =>
        store.listMessages(sid, after ? { after } : {}).map((m) => ({ id: m.id, role: m.role, text: m.text })),
      isAlive: (messageId) => {
        if (!activeIds) {
          activeIds = new Set<string>();
          for (const s of store.listSessions()) for (const m of store.listMessages(s.id)) activeIds.add(m.id);
        }
        return activeIds.has(messageId);
      },
      complete: async (model, system, user) => {
        const res = await agentModel.complete({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        });
        return res.text;
      },
      extractModel: (agentId) => {
        const agentRoles = liveCfg().agent.agents.find((a) => a.id === agentId)?.roles;
        return resolveAgentModelRole(liveCfg().model, agentRoles, 'memory') ?? liveCfg().model.default;
      },
      log: graphLog
    });
  };
  // Opt-in background catch-up (memory.graph.autoConsolidate). A coarse 60s tick gated by graphAutoDue
  // so a hot-reloaded interval/flag takes effect without recreating the timer; one run at a time. The
  // first run waits a full interval (graphLastRun seeded to now) to avoid churn on every restart.
  let graphLastRun = Date.now();
  let graphRunning = false;
  const graphTimer = setInterval(() => {
    if (graphRunning || !graphAutoDue(liveCfg().memory.graph, graphLastRun, Date.now())) return;
    graphRunning = true;
    graphLastRun = Date.now();
    void runGraphConsolidate()
      .then((r) =>
        graphLog.info(`auto-consolidate: ${r.sessionsExtracted} session(s), +${r.nodes} node(s)/${r.edges} edge(s)`)
      )
      .catch((err) => graphLog.warn(`auto-consolidate failed: ${String(err)}`))
      .finally(() => {
        graphRunning = false;
      });
  }, 60_000);
  graphTimer.unref?.();
  process.on('exit', () => clearInterval(graphTimer));

  // Read-only mem0 explorer (GET /v1/memory/mem0): every stored memory across scopes + a 2D embedding
  // projection for the cluster view + vector-store status. Vectors are read from the running qdrant
  // ONLY if it's already up (urlIfReady) — peeking must never trigger a download/boot.
  const getMem0Data = () =>
    collectMem0Data({
      available: () => liveCfg().memory.backend === 'mem0',
      vectorStoreName: () => liveCfg().memory.mem0.vectorStore?.provider ?? 'qdrant',
      scopes: () => [
        { scope: 'global', kind: 'global' as const, id: '*' },
        ...liveCfg().agent.agents.map((a) => ({ scope: `agent:${a.id}`, kind: 'agent' as const, id: a.id }))
      ],
      listEntries: async (kind, id) =>
        (await memoryService.listFacts(kind, id)).map((f) => ({ id: f.id, text: f.content })),
      fetchVectors: async () => {
        const provider = liveCfg().memory.mem0.vectorStore?.provider ?? 'qdrant';
        const url = provider === 'qdrant' ? qdrant.urlIfReady() : null;
        return url ? fetchQdrantVectors(url, 'monad_memories') : new Map();
      },
      qdrantStatus: () => qdrant.getStatus(),
      log: graphLog
    });

  // Persist + hot-apply a memory settings change from the UI (writes profile.json, publishes the bus).
  const persistMemory = async (mutate: (m: MonadConfig['memory']) => void): Promise<void> => {
    mutate(liveCfg().memory);
    await saveProfile(paths.profile, liveCfg());
    await configBus.publish({ cfg: liveCfg(), auth: liveAuth() });
  };
  const memorySetBackend = async (backend: MemoryBackendId): Promise<void> => {
    await persistMemory((m) => {
      m.backend = backend;
    });
  };
  const memorySetMem0Models = async (sel: SetMem0ModelsRequest): Promise<void> => {
    await persistMemory((m) => {
      if (sel.llm !== undefined) m.mem0.llm = sel.llm ?? undefined;
      if (sel.embedder !== undefined) m.mem0.embedder = sel.embedder ?? undefined;
      if (sel.embedDim !== undefined) m.mem0.embedDim = sel.embedDim ?? undefined;
    });
  };

  // Memory lifecycle (recall / observe / session-end), folding the note-store block into recall's
  // BeforeTurn context. Shared with the e2e via registerMemoryHooks so the wiring can't drift.
  registerMemoryHooks(registry, memoryService, {
    extraContext: (sessionId) => renderNotes(noteStore, sessionId)
  });

  return {
    noteStore,
    memoryService,
    graphStore,
    graphScopesFor,
    runGraphConsolidate,
    getMem0Data,
    memorySetBackend,
    memorySetMem0Models
  };
}

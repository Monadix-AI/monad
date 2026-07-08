// Boot phase: the memory subsystem — the auto-memory note store, the layered L1 memory service
// (built-in MD or mem0, with a daemon-managed local qdrant), the L2 knowledge graph + its opt-in
// background consolidation, the read-only mem0 explorer, and the memory settings write-back. Returns
// the handles the rest of startDaemon wires into agents (memory/graph tools), handlers, and commands.
//
// Live config + auth are read via getters so a settings hot-reload (credential change, model swap,
// backend switch) takes effect without rebuilding the service. mem0 selects its LLM + embedder FROM
// that config (no env vars).

import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type {
  GetLawsResponse,
  MemoryBackendId,
  SessionId,
  SetMem0ModelsRequest,
  SetMemoryGraphRequest
} from '@monad/protocol';
import type { BeliefExplanation, ConsolidateSummary } from '@monad/sdk-atom';
import type { ModelRouter } from '#/agent/index.ts';
import type { NoteStore } from '#/capabilities/tools/registry/memory.ts';
import type { ConfigBus } from '#/services/config-bus.ts';
import type { MemoryHookRegistry } from '#/services/memory/hooks.ts';
import type { MemoryService } from '#/services/memory/index.ts';
import type { Mem0Data } from '#/services/memory/mem0-explorer.ts';
import type { Store } from '#/store/db/index.ts';

import { join } from 'node:path';
import { saveProfile } from '@monad/home';
import { createLogger } from '@monad/logger';

import { renderNotes } from '#/capabilities/tools/registry/memory.ts';
import { resolveAgentModelRole } from '#/config/resolve.ts';
import { ConsolidationState } from '#/services/memory/consolidation-state.ts';
import { type CheckResult, checkContradictionsForScopes } from '#/services/memory/contradict.ts';
import { DEFAULT_DECAY, decayedConfidence, isRecallEligible } from '#/services/memory/decay.ts';
import { matchLaws } from '#/services/memory/explain.ts';
import { consolidateGraph, graphAutoDue } from '#/services/memory/graph/service.ts';
import { GraphStore } from '#/services/memory/graph/store.ts';
import { registerMemoryHooks } from '#/services/memory/hooks.ts';
import { createMemoryService } from '#/services/memory/index.ts';
import { inferLawsForScopes } from '#/services/memory/law-infer.ts';
import { LawStore } from '#/services/memory/law-store.ts';
import { collectMem0Data, fetchQdrantVectors } from '#/services/memory/mem0-explorer.ts';
import { QdrantManager } from '#/services/memory/qdrant.ts';
import { resolveMem0Models } from '#/services/memory/resolve-mem0.ts';
import { projectKey } from '#/store/db/index.ts';

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
  runConsolidate: (levelOverride?: number) => Promise<ConsolidateSummary>;
  runCheckContradictions: () => Promise<CheckResult>;
  getMem0Data: () => Promise<Mem0Data>;
  getLaws: () => Promise<GetLawsResponse>;
  explainBelief: (sessionId: string, query: string) => Promise<BeliefExplanation>;
  memorySetBackend: (backend: MemoryBackendId) => Promise<void>;
  memorySetMem0Models: (sel: SetMem0ModelsRequest) => Promise<void>;
  memorySetGraph: (sel: SetMemoryGraphRequest) => Promise<void>;
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

  // L3 inferred laws — shares the memory DB (db/memory.sqlite, own graph_law table). Injected into
  // recall below so the agent's learned rules guide every turn.
  const lawStore = new LawStore(join(paths.dbDir, 'memory.sqlite'));
  process.on('exit', () => lawStore.close());

  // Incremental consolidation: per-scope input fingerprints so /consolidate skips unchanged scopes.
  const consolidationState = new ConsolidationState(join(paths.dbDir, 'memory.sqlite'));
  process.on('exit', () => consolidationState.close());

  const memoryService = createMemoryService({
    store,
    root: paths.memory,
    dbRoot: paths.dbDir,
    // Recall only injects laws that are neither contradicted nor decayed below the floor — never feed
    // the agent a known-wrong or long-unconfirmed rule.
    laws: (scopes) => {
      const now = Date.now();
      const decay = {
        halfLifeDays: liveCfg().memory.decay?.halfLifeDays ?? DEFAULT_DECAY.halfLifeDays,
        floor: liveCfg().memory.decay?.floor ?? DEFAULT_DECAY.floor
      };
      return lawStore
        .listLaws(scopes)
        .filter((l) => isRecallEligible(l, now, decay))
        .map((l) => ({ statement: l.statement, confidence: l.confidence }));
    },
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
    // L2 graph consolidation settings (read live so the UI reflects hot-reloaded changes).
    graphSettings: () => liveCfg().memory.graph,
    level: () => liveCfg().memory.level,
    consolidationState,
    log: createLogger('memory')
  });

  // L2 knowledge graph (manual /consolidate-graph + the graph_explore/graph_node read tools). Shares
  // db/memory.sqlite with L3 laws; agent-scoped reads.
  const graphLog = createLogger('graph');
  const graphStore = new GraphStore(join(paths.dbDir, 'memory.sqlite'));
  process.on('exit', () => graphStore.close());
  const graphScopesFor = (sessionId: string): string[] => {
    const s = store.getSession(sessionId as SessionId);
    const p = s ? null : store.getWorkplaceProject(sessionId);
    const scopes: string[] = [];
    if (s?.agentIds[0]) scopes.push(`agent:${s.agentIds[0]}`);
    const cwd = s?.cwd ?? p?.cwd;
    if (cwd) scopes.push(`project:${projectKey(cwd)}`);
    return scopes;
  };

  const projectScopeWorkspaces = (): string[] => {
    const seen = new Set<string>();
    for (const target of [...store.listSessions(), ...store.listWorkplaceProjects()]) {
      if (!target.cwd) continue;
      const key = projectKey(target.cwd);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    return [...seen];
  };

  const graphConsolidationTargets = () => [
    ...store.listSessions().map((s) => ({
      id: s.id,
      agentId: s.agentIds[0] ?? null,
      projectKey: s.cwd ? projectKey(s.cwd) : null
    })),
    ...store.listWorkplaceProjects().map((p) => ({
      id: p.id,
      agentId: null,
      projectKey: p.cwd ? projectKey(p.cwd) : null
    }))
  ];

  // Parse a scope string back to (kind, id) for a fact lookup — the inverse of the `<kind>:<id>` form.
  const splitScope = (scope: string): { kind: 'global' | 'agent' | 'project'; id: string } =>
    scope.startsWith('agent:')
      ? { kind: 'agent', id: scope.slice('agent:'.length) }
      : scope.startsWith('project:')
        ? { kind: 'project', id: scope.slice('project:'.length) }
        : { kind: 'global', id: '*' };

  // The scopes a global memory pass (laws, contradictions) ranges over: global, every configured
  // agent, and every distinct workspace that has a session. Shared so the passes never drift.
  const lawScopeRefs = (): { scope: string; kind: 'global' | 'agent' | 'project'; id: string }[] => {
    const refs: { scope: string; kind: 'global' | 'agent' | 'project'; id: string }[] = [
      { scope: 'global', kind: 'global', id: '*' },
      ...liveCfg().agent.agents.map((a) => ({ scope: `agent:${a.id}`, kind: 'agent' as const, id: a.id }))
    ];
    for (const key of projectScopeWorkspaces()) {
      refs.push({ scope: `project:${key}`, kind: 'project', id: key });
    }
    return refs;
  };
  const runGraphConsolidate = () => {
    let activeIds: Set<string> | null = null; // built once per pass: every live (active) message id
    return consolidateGraph({
      store: graphStore,
      sessions: graphConsolidationTargets,
      messagesAfter: (sid, after) =>
        store.listMessages(sid, after ? { after } : {}).map((m) => ({ id: m.id, role: m.role, text: m.text })),
      isAlive: (messageId) => {
        if (!activeIds) {
          activeIds = new Set<string>();
          for (const s of store.listSessions()) for (const m of store.listMessages(s.id)) activeIds.add(m.id);
          for (const p of store.listWorkplaceProjects()) for (const m of store.listMessages(p.id)) activeIds.add(m.id);
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

  // L3: manual /infer-laws — re-derive each scope's laws from its L1 facts + L2 graph relations.
  const lawLog = createLogger('laws');
  const runInferLaws = () => {
    // Snapshot the graph ONCE per pass and index edges by scope, so graphItems is an O(1) lookup
    // rather than a full graph_node/graph_edge load per scope (it ranges over every scope).
    const { nodes, edges } = graphStore.snapshot();
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    const edgesByScope = new Map<string, { id: string; text: string }[]>();
    for (const e of edges) {
      const list = edgesByScope.get(e.scope) ?? [];
      list.push({
        id: e.id,
        text: `${nameById.get(e.src) ?? e.src} —[${e.relation}]→ ${nameById.get(e.dst) ?? e.dst}`
      });
      edgesByScope.set(e.scope, list);
    }
    return inferLawsForScopes({
      store: lawStore,
      state: consolidationState,
      scopes: lawScopeRefs,
      facts: (kind, id) => memoryService.listFacts(kind, id),
      graphItems: (scope) => edgesByScope.get(scope) ?? [],
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
      model: (scope) => {
        const agentId = scope.startsWith('agent:') ? scope.slice('agent:'.length) : undefined;
        const agentRoles = agentId ? liveCfg().agent.agents.find((a) => a.id === agentId)?.roles : undefined;
        return resolveAgentModelRole(liveCfg().model, agentRoles, 'memory') ?? liveCfg().model.default;
      },
      log: lawLog
    });
  };

  // /check-memory: flag laws contradicted by a current fact (and clear ones no longer contradicted).
  // A flagged law is suppressed from recall; /consolidate re-derives and clears the flags.
  const runCheckContradictions = () =>
    checkContradictionsForScopes({
      scopes: lawScopeRefs,
      laws: (scope) => lawStore.listLaws([scope]).map((l) => ({ id: l.id, statement: l.statement })),
      facts: (kind, id) => memoryService.listFacts(kind, id),
      mark: (scope, byLawId) => lawStore.setContradictions(scope, byLawId),
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
      model: (scope) => {
        const agentId = scope.startsWith('agent:') ? scope.slice('agent:'.length) : undefined;
        const agentRoles = agentId ? liveCfg().agent.agents.find((a) => a.id === agentId)?.roles : undefined;
        return resolveAgentModelRole(liveCfg().model, agentRoles, 'memory') ?? liveCfg().model.default;
      },
      log: lawLog
    });

  // The unified pipeline: run L1 fact dedup, then (level>=2) the L2 graph, then (level>=3) L3 laws.
  // `/consolidate` and the background timer both call this; depth defaults to the configured level.
  const runConsolidate = async (levelOverride?: number): Promise<ConsolidateSummary> => {
    const level = Math.min(3, Math.max(1, levelOverride ?? liveCfg().memory.level));
    const l1 = await memoryService.consolidateAll();
    const summary: ConsolidateSummary = {
      level,
      l1Scopes: l1.filter((r) => r.after !== r.before).length,
      nodes: 0,
      edges: 0,
      prunedEdges: 0,
      laws: 0,
      lawScopes: 0
    };
    if (level >= 2) {
      const g = await runGraphConsolidate();
      summary.nodes = g.nodes;
      summary.edges = g.edges;
      summary.prunedEdges = g.prunedEdges;
    }
    if (level >= 3) {
      const l = await runInferLaws();
      summary.laws = l.laws;
      summary.lawScopes = l.scopesProcessed;
    }
    return summary;
  };

  // Opt-in background catch-up (memory.graph.autoConsolidate). A coarse 60s tick gated by graphAutoDue
  // so a hot-reloaded interval/flag takes effect without recreating the timer; one run at a time. The
  // first run waits a full interval (lastRun seeded to now) to avoid churn on every restart. Runs the
  // whole pipeline to the configured level, not just the graph.
  let lastRun = Date.now();
  let running = false;
  const timer = setInterval(() => {
    if (running || !graphAutoDue(liveCfg().memory.graph, lastRun, Date.now())) return;
    running = true;
    lastRun = Date.now();
    void runConsolidate()
      .then((r) =>
        graphLog.info(
          `auto-consolidate: L${r.level}, ${r.l1Scopes} scope(s), +${r.nodes}/${r.edges} graph, ${r.laws} law(s)`
        )
      )
      .catch((err) => graphLog.warn(`auto-consolidate failed: ${String(err)}`))
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref?.();
  process.on('exit', () => clearInterval(timer));

  // Read-only mem0 explorer (GET /v1/memory/mem0): every stored memory across scopes + a 2D embedding
  // projection for the cluster view + vector-store status. Vectors are read from the running qdrant
  // ONLY if it's already up (urlIfReady) — peeking must never trigger a download/boot.
  const getMem0Data = () =>
    collectMem0Data({
      available: () => liveCfg().memory.backend === 'mem0',
      vectorStoreName: () => liveCfg().memory.mem0.vectorStore?.provider ?? 'qdrant',
      scopes: lawScopeRefs,
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
  const memorySetGraph = async (sel: SetMemoryGraphRequest): Promise<void> => {
    await persistMemory((m) => {
      if (sel.level !== undefined && sel.level !== null) m.level = sel.level;
      // `memory.graph` is optional in the schema — materialize it on first write.
      m.graph ??= {};
      if (sel.autoConsolidate !== undefined) m.graph.autoConsolidate = sel.autoConsolidate ?? undefined;
      if (sel.intervalMinutes !== undefined) m.graph.intervalMinutes = sel.intervalMinutes ?? undefined;
    });
  };
  // Resolve each law's stored id refs (fact:<id> / edge:<id>) into readable grounding — the facts it
  // generalizes + the graph relations it rests on. This is the "why do you believe X" provenance.
  const getLaws = async (): Promise<GetLawsResponse> => {
    const laws = lawStore.listAll();
    const now = Date.now();
    const halfLifeDays = liveCfg().memory.decay?.halfLifeDays ?? DEFAULT_DECAY.halfLifeDays;
    const { nodes, edges } = graphStore.snapshot();
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const factCache = new Map<string, Map<string, string>>();
    const factsFor = async (scope: string): Promise<Map<string, string>> => {
      const cached = factCache.get(scope);
      if (cached) return cached;
      const { kind, id } = splitScope(scope);
      const m = new Map((await memoryService.listFacts(kind, id)).map((f) => [f.id, f.content]));
      factCache.set(scope, m);
      return m;
    };

    const out = [];
    for (const law of laws) {
      const fm = await factsFor(law.scope);
      const facts: { id: string; content: string }[] = [];
      const edgeList: { id: string; label: string }[] = [];
      for (const ref of law.support) {
        if (ref.startsWith('fact:')) {
          const id = ref.slice('fact:'.length);
          const content = fm.get(id);
          if (content) facts.push({ id, content });
        } else if (ref.startsWith('edge:')) {
          const id = ref.slice('edge:'.length);
          const e = edgeById.get(id);
          if (e)
            edgeList.push({
              id,
              label: `${nameById.get(e.src) ?? e.src} —${e.relation}→ ${nameById.get(e.dst) ?? e.dst}`
            });
        }
      }
      out.push({
        id: law.id,
        scope: law.scope,
        statement: law.statement,
        confidence: law.confidence,
        effectiveConfidence: decayedConfidence(law.confidence, law.updatedAt, now, halfLifeDays),
        // Invalidated: the law had grounding refs but none resolve any more — its provenance eroded.
        stale: law.support.length > 0 && facts.length + edgeList.length === 0,
        updatedAt: law.updatedAt,
        contradictedBy: law.contradictedBy,
        grounding: { facts, edges: edgeList }
      });
    }
    return { laws: out };
  };

  // /why <text>: trace a belief to its source. Match the query against the session's laws, then for
  // each match resolve the facts it generalizes, the relations it rests on, and the source messages
  // those relations were extracted from — the full law → {facts, edges} → messages chain.
  const runExplainBelief = async (sessionId: string, query: string): Promise<BeliefExplanation> => {
    const scopes = ['global', ...graphScopesFor(sessionId)];
    const matched = matchLaws(lawStore.listLaws(scopes), query);
    if (matched.length === 0) return { matches: [] };

    const { nodes, edges } = graphStore.snapshot();
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const factCache = new Map<string, Map<string, string>>();
    const factsFor = async (scope: string): Promise<Map<string, string>> => {
      const cached = factCache.get(scope);
      if (cached) return cached;
      const { kind, id } = splitScope(scope);
      const m = new Map((await memoryService.listFacts(kind, id)).map((f) => [f.id, f.content]));
      factCache.set(scope, m);
      return m;
    };

    const matches = [];
    for (const law of matched) {
      const fm = await factsFor(law.scope);
      const facts: string[] = [];
      const relations: string[] = [];
      const sources = new Set<string>();
      for (const ref of law.support) {
        if (ref.startsWith('fact:')) {
          const content = fm.get(ref.slice('fact:'.length));
          if (content) facts.push(content);
        } else if (ref.startsWith('edge:')) {
          const e = edgeById.get(ref.slice('edge:'.length));
          if (!e) continue;
          relations.push(`${nameById.get(e.src) ?? e.src} —${e.relation}→ ${nameById.get(e.dst) ?? e.dst}`);
          for (const mid of e.support) {
            const text = store.getMessageText(mid);
            if (text) sources.add(text.length > 160 ? `${text.slice(0, 160)}…` : text);
          }
        }
      }
      matches.push({ statement: law.statement, confidence: law.confidence, facts, relations, sources: [...sources] });
    }
    return { matches };
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
    runConsolidate,
    runCheckContradictions,
    getMem0Data,
    getLaws,
    explainBelief: runExplainBelief,
    memorySetBackend,
    memorySetMem0Models,
    memorySetGraph
  };
}

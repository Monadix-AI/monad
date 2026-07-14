// Daemon-side orchestration for L1 memory. A single active backend is selected by
// `cfg.memory.backend`: 'builtin' = local Markdown (MemoryDir) or 'mem0' = mem0 OSS (lazy-loaded).
//
// Design A (Claude Code model): the agent curates its OWN memory through one `memory` tool
// (view/record/update/delete) as it works. Recall does NOT inject the facts — it injects a cheap,
// per-session-frozen INDEX (what scopes exist + counts) so the agent knows what to `view`. Static
// identity (SOUL.md/AGENT.md/USER.md) is injected separately as the always-on core. There is no
// per-turn extraction and no automatic session-end rewrite; cleanup is the agent inline + a manual
// `/consolidate-memory` pass. mem0 stays passive (every-turn extraction + semantic recall).

import type { Logger } from '@monad/logger';
import type {
  AgentId,
  Fact,
  MemoryBackendId,
  MemoryScope,
  MemoryStatusResponse,
  QdrantPhase,
  ScopeKind,
  SessionId
} from '@monad/protocol';
import type { ModelRouter } from '#/agent/index.ts';
import type { Mem0Resolution } from '#/services/memory/resolve-mem0.ts';
import type { Store } from '#/store/db/index.ts';

import { join } from 'node:path';

import { type MemoryTurn, sanitizeFact } from '#/agent/index.ts';
import { definePrompt } from '#/agent/prompt-template.ts';
import { fingerprint } from '#/services/memory/consolidation-state.ts';
import { type BuildMem0Options, buildMem0Client, Mem0Adapter, type Mem0Client } from '#/services/memory/mem0.ts';
import { factId, MemoryDir, projectKey, scopeOf } from '#/store/db/index.ts';
// `with { type: 'file' }` embeds reliably in bun's --compile binary (unlike new URL+import.meta.url).
import consolidateSystemPath from './prompts/consolidate-system.prompt.md' with { type: 'file' };
import consolidateUserPath from './prompts/consolidate-user.prompt.md' with { type: 'file' };
import recallContextPath from './prompts/recall-context.prompt.md' with { type: 'file' };

export interface MemoryServiceDeps {
  store: Store;
  /** Root dir for the user-readable MD memory tree (paths.memory) — only MEMORY*.md lives here. */
  root: string;
  /** Root dir for binary databases (paths.dbDir) — mem0's local history.db lives under it. */
  dbRoot: string;
  router: ModelRouter;
  /** Model for the consolidation pass — resolved per-agent (the `memory` role, with a per-agent
   *  override falling back to the global role, then the chat default). */
  extractModel: (agentId?: AgentId) => string;
  /** The active backend (read live so a hot config reload takes effect). */
  backend: () => MemoryBackendId;
  /** mem0's LLM + embedder resolved from Monad's model registry (no env vars). */
  mem0Models: () => Mem0Resolution;
  /** mem0's vector store (read live). May be async — the default resolver starts a managed local
   *  qdrant on first use. Unset/undefined ⇒ in-RAM (non-persistent across restart). */
  mem0VectorStore?: () =>
    | { provider: string; config?: Record<string, unknown> }
    | undefined
    | Promise<{ provider: string; config?: Record<string, unknown> } | undefined>;
  /** Test seam: override the mem0 client builder (defaults to the lazy `mem0ai/oss` loader). */
  buildMem0?: (opts: BuildMem0Options, log: Logger) => Promise<Mem0Client | null>;
  /** Current qdrant lifecycle state. Returns undefined when user configured their own vector store. */
  qdrantStatus?: () => { phase: string; error: string | null } | undefined;
  /** L2 graph consolidation settings (read live, for the UI). undefined ⇒ unset (defaults apply). */
  graphSettings?: () => { autoConsolidate?: boolean; intervalMinutes?: number } | undefined;
  /** Consolidation pipeline depth (1-3, read live for the UI). Defaults to 1 when unset. */
  level?: () => number;
  /** Incremental L1: skip the dedup of a scope whose facts are unchanged since the last pass. */
  consolidationState?: { get(key: string): string | null; set(key: string, fp: string): void };
  /** L3 inferred laws for the given scopes (e.g. ['global','agent:<id>']). Injected into recall —
   *  independent of the L1 backend (laws live in the graph DB). Unset ⇒ no law injection. */
  laws?: (scopes: string[]) => { statement: string; confidence: number }[];
  log: Logger;
}

const FACTS_CHAR_BUDGET = 2000;
// When one scope's facts grow past this, auto-consolidate (dedup/merge) that single file in the
// background so no file balloons — one scope = one MD file, so we compress it rather than split it.
const CONSOLIDATE_CHAR_TRIGGER = 2000;

const CONSOLIDATE_SYSTEM_PROMPT = await definePrompt({
  id: 'memory.consolidate.system',
  sourcePath: consolidateSystemPath
});
const CONSOLIDATE_USER_PROMPT = await definePrompt<{ facts: string[] }>({
  id: 'memory.consolidate.user',
  sourcePath: consolidateUserPath
});
const RECALL_CONTEXT_PROMPT = await definePrompt<{
  globalFacts: string[];
  laws: string[];
  mem0Facts: string[];
  privateFactCount: number;
  projectFacts: string[];
}>({ id: 'memory.recall-context', sourcePath: recallContextPath });

// Returns the parsed fact list, or null when the text has no usable JSON array (so the caller can
// distinguish "model said empty" — [] — from "model output was unparseable" — null).
function parseFactArray(text: string): string[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return null;
  }
}

export type MemoryToolScope = 'agent' | 'global' | 'project';
export type MemoryToolResult = { ok: boolean; note?: string; content?: string };
interface ConsolidateResult {
  scope: string;
  before: number;
  after: number;
}

export interface MemoryService {
  /** Per-session-frozen recall injected into the prompt: the index (builtin) or semantic facts (mem0). */
  recallContext(sessionId: SessionId, query: string): Promise<string | undefined>;
  observeTurn(sessionId: SessionId): void;
  endSession(sessionId: SessionId): Promise<void>;
  /** Whether the active backend exposes the agent-facing `memory` tool (built-in does; mem0 is passive). */
  toolsActive(): boolean;
  /** Agent tool dispatch. action: view | record | update | delete. */
  memoryTool(
    sessionId: SessionId,
    action: 'view' | 'record' | 'update' | 'delete',
    args: { fact?: string; old?: string; replacement?: string; scope?: MemoryToolScope }
  ): Promise<MemoryToolResult>;
  /** Manual consolidation (the /consolidate-memory command): dedup/merge/correct every durable scope. */
  consolidateAll(): Promise<ConsolidateResult[]>;
  /** Active backend + mem0's resolved model selection + L2 graph settings (for the UI). */
  status(): MemoryStatusResponse;
  listFacts(kind: ScopeKind, id: string): Promise<Fact[]>;
  getCore(kind: ScopeKind, id: string): Promise<string>;
  putCore(kind: ScopeKind, id: string, md: string): Promise<void>;
  addFact(kind: ScopeKind, id: string, content: string): Promise<Fact | null>;
  editFact(kind: ScopeKind, id: string, factId: string, content: string): Promise<Fact | null>;
  forgetFact(kind: ScopeKind, id: string, factId: string): Promise<boolean>;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const memoryDir = new MemoryDir(deps.root);
  deps.log.info(`memory: L1 service ready — backend=${deps.backend()} root=${deps.root}`);

  // Prefix-cache freeze: the recalled block is folded into the cached system prompt, so re-reading a
  // changed index mid-session would shift the prefix and miss the prompt cache on every memory write.
  // We snapshot recall at first use per session and reuse it unchanged all session — writes still land
  // on disk immediately (and the agent reads live content via the `view` action), surfacing in the NEXT
  // session's snapshot (Claude Code / Hermes semantics). mem0 recall is query-dependent, not frozen.
  const recallSnapshot = new Map<SessionId, string | undefined>();

  let mem0Cache: Mem0Adapter | null | undefined;
  let mem0Building: Promise<Mem0Adapter | null> | undefined;
  const getMem0 = async (): Promise<Mem0Adapter | null> => {
    if (mem0Cache !== undefined) return mem0Cache;
    mem0Building ??= (async () => {
      const build = deps.buildMem0 ?? buildMem0Client;
      const client = await build(
        {
          models: deps.mem0Models().models,
          historyDbPath: join(deps.dbRoot, 'mem0', 'history.db'),
          vectorStore: await deps.mem0VectorStore?.()
        },
        deps.log
      );
      mem0Cache = client ? new Mem0Adapter(client, deps.log) : null;
      return mem0Cache;
    })();
    return mem0Building;
  };
  const activeMem0 = async (): Promise<Mem0Adapter | null> => (deps.backend() === 'mem0' ? getMem0() : null);

  const agentOf = (sessionId: SessionId): AgentId | null =>
    (deps.store.getSession(sessionId)?.agentIds[0] as AgentId | undefined) ?? null;

  const lastTurn = (sessionId: SessionId): MemoryTurn | null => {
    const msgs = deps.store.listMessages(sessionId, {}).slice(-12);
    let user = '';
    let assistant = '';
    for (const m of msgs) {
      if (m.role === 'user' && m.text) user = m.text;
      if (m.role === 'assistant' && m.text) assistant = m.text;
    }
    return user || assistant ? { user, assistant } : null;
  };

  // The workspace scope for a session = `project:<key>` derived from its cwd; null when it has none.
  const projectScopeOf = (sessionId: SessionId): MemoryScope | null => {
    const cwd = (deps.store.getSession(sessionId) ?? deps.store.getWorkplaceProject(sessionId))?.cwd;
    return cwd ? scopeOf('project', projectKey(cwd)) : null;
  };

  // Resolve the write target scope for a tool call ('global' → shared, 'agent' → this session's agent,
  // 'project' → the session's workspace).
  const writeScope = (sessionId: SessionId, scope: MemoryToolScope): MemoryScope | null => {
    if (scope === 'global') return scopeOf('global', '*');
    if (scope === 'project') return projectScopeOf(sessionId);
    const agentId = agentOf(sessionId);
    return agentId ? scopeOf('agent', agentId) : null;
  };

  const renderFacts = (facts: Fact[]): string =>
    facts.length ? facts.map((f) => `- ${f.content}`).join('\n') : '(no facts in this scope yet)';

  const consolidateScope = async (scope: MemoryScope): Promise<ConsolidateResult> => {
    const label = scope.kind === 'global' ? 'global' : `${scope.kind}:${scope.id}`;
    const facts = memoryDir.listFacts(scope);
    if (facts.length < 2) return { scope: label, before: facts.length, after: facts.length };
    // Incremental: skip the LLM dedup when this scope's fact set is unchanged since the last pass.
    const fp = fingerprint(facts.map((f) => f.id));
    if (deps.consolidationState?.get(`l1:${label}`) === fp)
      return { scope: label, before: facts.length, after: facts.length };
    const model = deps.extractModel(scope.kind === 'agent' ? (scope.id as AgentId) : undefined);
    try {
      const res = await deps.router.complete({
        model,
        messages: [
          { role: 'system', content: CONSOLIDATE_SYSTEM_PROMPT.render({}) },
          { role: 'user', content: CONSOLIDATE_USER_PROMPT.render({ facts: facts.map((f) => f.content) }) }
        ]
      });
      const cleaned = parseFactArray(res.text);
      if (cleaned === null) {
        deps.log.warn(`memory: consolidate(${label}) produced no parseable list — keeping current`);
        return { scope: label, before: facts.length, after: facts.length };
      }
      const safe = cleaned
        .map(sanitizeFact)
        .filter((s) => s.ok)
        .map((s) => s.cleaned);
      // Never let a non-empty scope be wiped to empty by one bad rewrite.
      if (safe.length === 0 && facts.length > 0) return { scope: label, before: facts.length, after: facts.length };
      memoryDir.replaceFacts(scope, safe);
      deps.consolidationState?.set(`l1:${label}`, fingerprint(safe.map(factId)));
      deps.log.info(`memory: consolidate(${label}) ${facts.length} → ${safe.length} fact(s)`);
      return { scope: label, before: facts.length, after: safe.length };
    } catch (err) {
      deps.log.warn(`memory: consolidate(${label}) failed: ${String(err)}`);
      return { scope: label, before: facts.length, after: facts.length };
    }
  };

  // Built-in recall (frozen per session): GLOBAL facts (about the user) are inlined so they are always
  // in scope — they're small and almost always relevant, and an agent shouldn't have to remember to
  // `view` what it learned about the user. AGENT-private facts can be large/situational, so they are
  // advertised by count and read on demand via the `view` action.
  const builtinRecallData = (agentId: AgentId, projectScope: MemoryScope | null) => {
    const gFacts = memoryDir.listFacts(scopeOf('global', '*'));
    const aFacts = memoryDir.listFacts(scopeOf('agent', agentId));
    const pFacts = projectScope ? memoryDir.listFacts(projectScope) : [];
    return {
      globalFacts: gFacts.map((f) => f.content),
      privateFactCount: aFacts.length,
      projectFacts: pFacts.map((f) => f.content)
    };
  };

  // Background dedup/merge of a single scope once its facts exceed the char trigger (keeps one file
  // bounded without splitting it). Fire-and-forget so it never blocks the turn; guarded against re-entry.
  const consolidating = new Set<string>();
  const maybeAutoConsolidate = (scope: MemoryScope): void => {
    const key = `${scope.kind}:${scope.id}`;
    if (consolidating.has(key)) return;
    const chars = memoryDir.listFacts(scope).reduce((n, f) => n + f.content.length + 3, 0);
    if (chars <= CONSOLIDATE_CHAR_TRIGGER) return;
    consolidating.add(key);
    deps.log.info(`memory: auto-consolidate ${key} (>${CONSOLIDATE_CHAR_TRIGGER} chars)`);
    void consolidateScope(scope).finally(() => consolidating.delete(key));
  };

  return {
    async recallContext(sessionId, query) {
      const agentId = agentOf(sessionId);
      if (!agentId) return undefined;
      const projectScope = projectScopeOf(sessionId);
      const mem0 = await activeMem0();
      // Built-in: serve the frozen per-session snapshot so the cached system prefix stays stable.
      if (!mem0 && recallSnapshot.has(sessionId)) return recallSnapshot.get(sessionId);
      let mem0Facts: string[] = [];
      if (mem0) {
        // mem0: semantic recall across the user (global), this workspace (project), and this agent.
        const scopes = [scopeOf('global', '*'), ...(projectScope ? [projectScope] : []), scopeOf('agent', agentId)];
        const block = await mem0.recall({
          query,
          sessionId,
          agentId,
          scopes,
          advanced: false,
          budget: { facts: FACTS_CHAR_BUDGET, graph: 0, laws: 0 }
        });
        mem0Facts = block.facts.map((fact) => fact.content);
      }
      // L3: append inferred laws (both backends — laws live in the graph DB, not the L1 store).
      const lawScopes = ['global', `agent:${agentId}`];
      if (projectScope) lawScopes.push(`project:${projectScope.id}`);
      const laws = deps.laws?.(lawScopes) ?? [];
      const builtin = mem0
        ? { globalFacts: [], privateFactCount: 0, projectFacts: [] }
        : builtinRecallData(agentId, projectScope);
      const renderedContext = RECALL_CONTEXT_PROMPT.render({
        ...builtin,
        laws: laws.map((law) => law.statement),
        mem0Facts
      });
      const rendered = renderedContext || undefined;
      if (!mem0) recallSnapshot.set(sessionId, rendered); // freeze the whole block (incl. laws) for the session
      return rendered;
    },

    // Per-turn write path is mem0-only (mem0 is passive — it must see every turn). The built-in
    // backend is agent-driven (the `memory` tool) + manual /consolidate, so it runs no per-turn LLM.
    observeTurn(sessionId) {
      if (deps.backend() !== 'mem0') return;
      const agentId = agentOf(sessionId);
      if (!agentId) return;
      const turn = lastTurn(sessionId);
      if (!turn) return;
      const scope: MemoryScope = { kind: 'agent', id: agentId };
      void getMem0()
        .then((mem0) => mem0?.observe(turn, { sessionId, scope }))
        .catch((err) => deps.log.warn(`memory: observe failed: ${String(err)}`));
    },

    async endSession(sessionId) {
      recallSnapshot.delete(sessionId); // next session takes a fresh snapshot (incl. this session's writes)
      // Drop ephemeral session-scoped memory. Durable scopes persist; cleanup is the agent inline +
      // manual /consolidate-memory, not an automatic session-end rewrite.
      memoryDir.dropScope({ kind: 'session', id: sessionId });
    },

    toolsActive() {
      return deps.backend() === 'builtin';
    },

    async memoryTool(sessionId, action, args) {
      const mem0 = await activeMem0();
      const scope: MemoryToolScope = args.scope ?? 'agent';
      // The write target is missing for different reasons per scope (no agent vs no workspace) —
      // tell the model the real one so it can fall back instead of dead-ending.
      const noTarget = scope === 'project' ? 'this session has no workspace' : 'this session has no agent';

      if (action === 'view') {
        if (mem0) {
          const target = writeScope(sessionId, scope);
          if (!target) return { ok: false, note: noTarget };
          return { ok: true, content: renderFacts(await mem0.listFacts(target)) };
        }
        // No scope arg → return the index (what exists). With a scope → that scope's full facts.
        if (!args.scope) return { ok: true, content: memoryDir.readIndex().trim() || '(no memory recorded yet)' };
        const target = writeScope(sessionId, scope);
        if (!target) return { ok: false, note: noTarget };
        return { ok: true, content: renderFacts(memoryDir.listFacts(target)) };
      }

      if (mem0) {
        return {
          ok: false,
          note:
            action === 'record'
              ? 'mem0 records memory automatically from the conversation'
              : 'mem0 manages memory automatically'
        };
      }
      const target = writeScope(sessionId, scope);
      if (!target) return { ok: false, note: `${noTarget} to attach memory to` };

      if (action === 'record') {
        const s = sanitizeFact(args.fact ?? '');
        if (!s.ok) return { ok: false, note: 'rejected (empty, secret-shaped, or injection-shaped)' };
        memoryDir.appendFact(target, { content: s.cleaned, provClass: 'machine' });
        maybeAutoConsolidate(target);
        return { ok: true };
      }
      if (action === 'update') {
        if (!args.old?.trim()) return { ok: false, note: 'a non-empty "old" fact to replace is required' };
        const s = sanitizeFact(args.replacement ?? '');
        if (!s.ok) return { ok: false, note: 'replacement rejected (empty, secret-shaped, or injection-shaped)' };
        const edited = memoryDir.editFact(target, factId(args.old.trim()), s.cleaned);
        return edited ? { ok: true } : { ok: false, note: 'no matching fact found to update' };
      }
      if (!args.fact?.trim()) return { ok: false, note: 'a non-empty "fact" to delete is required' };
      const removed = memoryDir.removeFact(target, factId(args.fact.trim()));
      return removed ? { ok: true } : { ok: false, note: 'no matching fact found' };
    },

    async consolidateAll() {
      if (deps.backend() !== 'builtin') return []; // mem0 self-manages
      const scopes = memoryDir.listScopes().filter((s) => s.kind !== 'session');
      const out: ConsolidateResult[] = [];
      for (const s of scopes) out.push(await consolidateScope(s));
      return out;
    },

    status() {
      const backend = deps.backend();
      const r = deps.mem0Models();
      const qdrant = deps.qdrantStatus?.();
      const graph = deps.graphSettings?.();
      // Distinct workspaces with memory, derived from transcript target cwds (key → path), for the project picker.
      const byKey = new Map<string, string>();
      for (const s of deps.store.listSessions()) if (s.cwd) byKey.set(projectKey(s.cwd), s.cwd);
      for (const p of deps.store.listWorkplaceProjects()) if (p.cwd) byKey.set(projectKey(p.cwd), p.cwd);
      return {
        backend,
        mem0: { llm: r.llm, embedder: r.embedder, embedDim: r.dim, ready: Boolean(r.models), error: r.error ?? null },
        qdrant: qdrant ? { phase: qdrant.phase as QdrantPhase, error: qdrant.error } : undefined,
        level: deps.level?.() ?? 1,
        projects: [...byKey].map(([key, path]) => ({ key, path })),
        graph: { autoConsolidate: graph?.autoConsolidate ?? null, intervalMinutes: graph?.intervalMinutes ?? null }
      };
    },

    async listFacts(kind, id) {
      const scope = scopeOf(kind, id);
      const mem0 = await activeMem0();
      return mem0 ? mem0.listFacts(scope) : memoryDir.listFacts(scope);
    },
    async getCore(kind, id) {
      if (deps.backend() === 'mem0') return '';
      return memoryDir.readCore(scopeOf(kind, id));
    },
    async putCore(kind, id, md) {
      if (deps.backend() === 'mem0') return;
      memoryDir.writeCore(scopeOf(kind, id), md);
    },
    async addFact(kind, id, content) {
      const scope = scopeOf(kind, id);
      const s = sanitizeFact(content);
      if (!s.ok) return null;
      const mem0 = await activeMem0();
      if (mem0) return mem0.addFact(scope, s.cleaned);
      return memoryDir.appendFact(scope, { content: s.cleaned, provClass: 'user' });
    },
    async editFact(kind, id, factId, content) {
      if (deps.backend() === 'mem0') return null;
      const s = sanitizeFact(content);
      if (!s.ok) return null;
      return memoryDir.editFact(scopeOf(kind, id), factId, s.cleaned);
    },
    async forgetFact(kind, id, factId) {
      const mem0 = await activeMem0();
      if (mem0) return mem0.forgetFact(factId);
      return memoryDir.removeFact(scopeOf(kind, id), factId);
    }
  };
}

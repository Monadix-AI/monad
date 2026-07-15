// Long-lived execution dependencies and repositories. The facade created here remains stable for
// the daemon lifetime; each model invocation creates its AgentLoop through `agent.loop(...)`.

import type { MonadConfig, MonadPaths } from '@monad/home';
import type { LoadedSkill } from '#/agent/index.ts';
import type { UserPromptSlots } from '#/agent/prompts.ts';
import type { FileObservationStore } from '#/capabilities/tools/types.ts';
import type { createHookRunner } from '#/hooks/runner.ts';
import type { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import type { DelegatableAgent } from '#/services/generation/agent-persona.ts';
import type { ClarifyService } from '#/services/generation/clarify.ts';
import type { ModelService } from '#/services/model.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';
import type { OversightService } from '#/services/oversight.ts';
import type { Store } from '#/store/db/index.ts';

import { createLogger } from '@monad/logger';

import {
  CompositeContextEngine,
  computeCost,
  createAgent,
  DurableSummarizer,
  parseDurableSummary,
  type SummaryStore,
  TokenLimiterContext,
  ToolResultEvictionContext
} from '#/agent/index.ts';
import { register as clarifyRegister } from '#/capabilities/tools/registry/clarify.ts';
import { only } from '#/capabilities/tools/registry/contract.ts';
import { register as delegateRegister } from '#/capabilities/tools/registry/delegate.ts';
import { register as imageRegister } from '#/capabilities/tools/registry/image.ts';
import { register as skillManageRegister } from '#/capabilities/tools/registry/skill-manage.ts';
import { register as toolCallRegister } from '#/capabilities/tools/registry/tool-call.ts';
import { register as toolSearchRegister } from '#/capabilities/tools/registry/tool-search.ts';
import { register as ttsRegister } from '#/capabilities/tools/registry/tts.ts';
import { register as visionRegister } from '#/capabilities/tools/registry/vision.ts';
import { register as agentDelegateRegister } from '#/services/delegation/agent-delegate.ts';
import { createInboundApprovalGate, type InboundApprovalMode } from '#/services/inbound-approval.ts';

const log = createLogger('agent:execution');

type CreateAgentOptions = Parameters<typeof createAgent>[0];
type AgentModel = NonNullable<CreateAgentOptions['model']>;
type AgentTools = NonNullable<CreateAgentOptions['tools']>;
type ToolList = Extract<AgentTools, unknown[]>;

export interface AgentDeps {
  agentModel: AgentModel;
  modelService: ModelService;
  modelCatalog: ModelCatalogService;
  store: Store;
  embeddingIndexer: EmbeddingIndexer;
  cfg: MonadConfig;
  paths: MonadPaths;
  sandboxRoots: string[] | undefined;
  oversight: OversightService;
  clarify: ClarifyService;
  loadedSkills: LoadedSkill[];
  /** LIVE base tools — read per turn so a hot-installed atom-pack/MCP tool (registry mutation)
   *  reaches the running agent without a daemon restart. */
  baseTools: () => ToolList;
  /** Bumps when baseTools changes, so the agent memoizes its composed tool list (no per-turn rebuild
   *  when nothing was installed/removed). The daemon passes `() => registry.toolRevision`. */
  toolsVersion: () => number;
  /** Externally-wired tools appended after the model-derived ones: schedule + memory + acp-delegate. */
  extraTools: ToolList;
  /** Live roster of `subagentCallable` Studio agents (from AgentPersonaService). When non-empty at
   *  boot, the daemon mounts `agent_delegate_to`; the target is re-resolved live per call. */
  delegatableAgents?: () => DelegatableAgent[];
  /** Resolve a tool's atom-pack/MCP source name (registry.sourceNameOf), to narrow a delegated
   *  agent's tools to its atoms allowlist. */
  toolSourceName?: (toolName: string) => string | undefined;
  hookRunner: ReturnType<typeof createHookRunner>;
  /** Inbound (peer-delegated) approval policy for high-risk tools — see services/inbound-approval.ts. */
  inboundApproval: () => InboundApprovalMode;
  /** Live user-editable prompt slots, resolved per turn (reloads take effect). Receives the active
   *  session id so the host can return that session's Studio agent persona (its AGENT.md), falling back
   *  to the global workspace AGENT slot while always preserving SOUL/USER. */
  workspacePromptSlots: (sessionId?: string) => UserPromptSlots;
}

export interface AgentExecutionService {
  agent: ReturnType<typeof createAgent>;
  /** Durable summarizer used by /compact and by prompt assembly. */
  history: DurableSummarizer;
}

export function createAgentExecutionService(deps: AgentDeps): AgentExecutionService {
  const {
    agentModel,
    modelService,
    modelCatalog,
    store,
    embeddingIndexer,
    cfg,
    paths,
    sandboxRoots,
    oversight,
    clarify,
    loadedSkills,
    baseTools,
    toolsVersion,
    extraTools,
    delegatableAgents,
    toolSourceName,
    hookRunner,
    inboundApproval,
    workspacePromptSlots
  } = deps;

  // High-risk tools in an inbound (peer-delegated) session follow the configured policy instead of
  // hanging on an approval the OpenAI-compat stream can't carry; the daemon's own sessions are
  // unaffected (straight to oversight). See services/inbound-approval.ts.
  const gate = createInboundApprovalGate({ store, mode: inboundApproval, fallback: oversight.gate });
  const fileObservations: FileObservationStore = {
    remember: (sessionId, observation) => store.recordFileObservation(sessionId, observation),
    get: (sessionId, path) => store.getFileObservation(sessionId, path),
    clear: (sessionId) => {
      store.clearFileObservations(sessionId);
    }
  };

  // Resolve the default profile's context-window size so the agent can emit `context.usage`
  // breakdowns and keep long sessions in-bounds.
  const defaultProfile = modelService.profiles.find((p) => p.alias === (cfg.model.default || 'default'));
  const defaultSpec = defaultProfile
    ? { provider: defaultProfile.routes.chat.provider, modelId: defaultProfile.routes.chat.modelId }
    : undefined;
  const contextLimit = defaultSpec
    ? modelCatalog.lookupContextLimit(defaultSpec.provider, defaultSpec.modelId)
    : undefined;

  // Per-agent budget overrides from the default agent's config row (if one is set).
  const defaultAgentCfg = cfg.agent.defaultAgentId
    ? cfg.agent.agents.find((a) => a.id === cfg.agent.defaultAgentId)
    : undefined;

  // Durable, bounded-load history: fold old turns into a rolling summary persisted in the store's
  // `memory` table, and each turn load only messages since the summary boundary — so per-turn DB
  // read stays O(window) and the summary survives restarts. The cheapest configured model
  // summarizes (falls back to the default). TokenLimiterContext remains the per-step in-turn guard
  // so the window can't overflow even mid tool-loop.
  const summaryModel =
    modelCatalog.pickProfileForTier('fast', modelService.profiles, modelService.tierOverrides) ??
    (cfg.model.default || 'default');
  const summaryStore: SummaryStore = {
    load: (sid) => parseDurableSummary(store.getMemory(sid, 'ctx:summary')),
    save: (sid, rec) => store.setMemory(sid, 'ctx:summary', JSON.stringify(rec))
  };
  const ctxCfg = cfg.context;
  const historySoftThreshold = Math.floor((contextLimit ?? 120_000) * ctxCfg.summarize.softFraction);
  const historyHardThreshold = Math.floor((contextLimit ?? 120_000) * ctxCfg.summarize.hardFraction);
  const history = new DurableSummarizer({
    messages: {
      list: (sid) => store.listMessages(sid),
      listSince: (sid, after) => store.listMessages(sid, { after })
    },
    summaryStore,
    model: agentModel,
    summaryModel,
    softThresholdTokens: historySoftThreshold,
    hardThresholdTokens: historyHardThreshold,
    background: ctxCfg.summarize.background,
    // BeforeCompact lifecycle event: let hooks inject "preserve this" instructions before lossy
    // compaction. Failures never block compaction — fall back to no extra instructions.
    preCompact: async ({ sessionId, trigger, tokens }) => {
      try {
        const d = await hookRunner.run({
          event: 'BeforeCompact',
          sessionId,
          cwd: sandboxRoots?.[0] ?? paths.workspace,
          timestamp: new Date().toISOString(),
          compaction: { trigger, tokens }
        });
        return d.additionalContext;
      } catch {
        return [];
      }
    },
    // AfterCompact: observe-only, fired once the summary is committed.
    afterCompact: ({ sessionId, trigger, tokens }) => {
      void hookRunner
        .run({
          event: 'AfterCompact',
          sessionId,
          cwd: sandboxRoots?.[0] ?? paths.workspace,
          timestamp: new Date().toISOString(),
          compaction: { trigger, tokens }
        })
        .catch(() => {});
    }
  });
  // Spill a truncated/evicted tool result's full output to the store (capped) so it can be recovered
  // by handle later instead of re-running the tool. Gated by config; shared by the tool-execution
  // truncation seam (below) and the eviction engine (both call it on the same table).
  const persistRawToolOutput = ctxCfg.toolOutput.persistRaw
    ? (sessionId: string, toolCallId: string, output: string) =>
        store.saveToolRawOutput(sessionId, toolCallId, output.slice(0, ctxCfg.toolOutput.rawCapBytes))
    : undefined;

  // In-turn context cascade (runs each model step, after the durable summarizer has assembled the
  // prompt): lossless tool-result eviction first, then a hard truncation guard so the window can't
  // overflow mid tool-loop even if summarization lagged. DurableSummarizer (above) remains the
  // durable, lineage-aware summary stage at assemble time.
  const eviction =
    contextLimit && ctxCfg.eviction.enabled
      ? new ToolResultEvictionContext({
          contextLimit,
          atFraction: ctxCfg.eviction.atFraction,
          keepRecentRounds: ctxCfg.eviction.keepRecentRounds,
          clearAtLeast: ctxCfg.eviction.clearAtLeast,
          minResultTokens: ctxCfg.eviction.minResultTokens,
          persistRawOutput: persistRawToolOutput
        })
      : undefined;
  const context = contextLimit
    ? new CompositeContextEngine([
        ...(eviction ? [eviction] : []),
        new TokenLimiterContext({ maxTokens: Math.floor(contextLimit * ctxCfg.summarize.hardFraction) })
      ])
    : undefined;
  const evictedTokens = eviction ? (sessionId: string) => eviction.reclaimedTokens(sessionId) : undefined;

  // Static (non-registry) tools — always visible to the model regardless of deferred mode. Each
  // module exposes the uniform `register(deps) => Tool[]` entry; we compose them with execution-local
  // deps (model, gate, context, …). Order is preserved for the prompt-cache prefix.
  const staticTools: ToolList = [
    ...skillManageRegister({ skillsDir: paths.skills }),
    ...delegateRegister({
      model: agentModel,
      tools: baseTools, // live getter → delegated subagents also see hot-installed tools
      defaultModel: cfg.model.default || 'default',
      userId: cfg.principal?.id,
      gate, // inbound-approval gate so delegated tools follow the peer-delegation policy too
      fileObservations,
      context,
      contextLimit,
      hooks: hookRunner // delegated subagents enforce the same hook policy as the main loop
    }),
    // Named-agent delegation (`agent_delegate_to`): mounted only when the operator has ≥1
    // `subagentCallable` Studio agent at boot (else the tool would advertise an empty roster). The
    // target persona + tool-narrowing are resolved live per call from AgentPersonaService.
    ...(delegatableAgents && delegatableAgents().length > 0
      ? agentDelegateRegister({
          agents: delegatableAgents,
          tools: baseTools,
          toolSource: toolSourceName ?? (() => undefined),
          model: agentModel,
          defaultModel: cfg.model.default || 'default',
          gate,
          fileObservations,
          context,
          contextLimit,
          hooks: hookRunner // delegated agents enforce the same hook policy as the main loop
        })
      : []),
    // Image/speech/vision models come from the active profile role assignment, resolved live.
    ...visionRegister({ model: agentModel, defaultModel: () => modelService.roleModel('vision') }),
    ...imageRegister({ router: agentModel, defaultImageModel: () => modelService.roleModel('image') }),
    ...ttsRegister({ router: agentModel, defaultSpeechModel: () => modelService.roleModel('speech') }),
    ...clarifyRegister({ ask: clarify.ask }),
    ...extraTools
  ];

  // Full live tool getter (registry + static) — used both as the agent's tools getter and
  // as the live-lookup closure for tool_search / tool_call.
  // Dedup by name so an atom-pack that happens to share a name with a static tool doesn't
  // produce duplicate entries that most LLM providers reject as an API error. Last write wins
  // (staticTools append last), so daemon-owned tools shadow same-named registry entries.
  const getAllTools = () => {
    const all = [...baseTools(), ...staticTools];
    const byName = new Map<string, (typeof all)[number]>();
    for (const t of all) byName.set(t.name, t);
    return [...byName.values()];
  };

  // Builtin names: static tools + auto-added skill tool + the meta-tools themselves.
  // Frozen at agent start so toolSpecs() is stable across turns → outer prefix cache holds.
  const builtinToolNames = new Set<string>(['skill', ...staticTools.map((t) => t.name), 'tool_search', 'tool_call']);

  const fastProfileId = modelCatalog.pickProfileForTier('fast', modelService.profiles, modelService.tierOverrides);
  if (!fastProfileId) {
    log.warn(
      {},
      'no "fast" model profile configured — tool_search will use the default model, which may be slower and more expensive'
    );
  }
  const searchModelId = fastProfileId ?? (cfg.model.default || 'default');

  const toolSearchTool = only(
    toolSearchRegister({
      model: agentModel,
      searchModelId,
      getTools: getAllTools,
      getToolRevision: toolsVersion,
      builtinToolNames,
      topK: 5
    })
  );
  const toolCallTool = only(toolCallRegister({ getTools: getAllTools }));

  const agent = createAgent({
    model: agentModel,
    // skill_manage lets the agent author its own skills (procedural memory); it's high-risk,
    // so writes route through the oversight gate. Edits land live via the WatchService.
    // A getter (not a fixed array) so the LIVE base tools compose with the static model-derived
    // tools each turn — a hot-installed atom-pack/MCP tool appears without a daemon restart.
    tools: getAllTools,
    // The model-derived tools above are static; only baseTools (the registry) changes, so the
    // registry revision is a sufficient memo key for the agent's per-turn tool composition.
    toolsVersion,
    toolSearchConfig: {
      searchTool: toolSearchTool,
      callTool: toolCallTool,
      builtinToolNames,
      threshold: 8_000,
      getToolRevision: toolsVersion
    },
    skills: loadedSkills,
    fileObservations,
    // Resolve a `context: fork` skill's declared tier (fast/smart/power) to a concrete profile
    // alias by ranking the live configured profiles on models.dev pricing, with operator tier
    // pins winning. Undefined when no configured profile matches the tier → the fork falls back
    // to the parent's default model.
    resolveTier: (tier) => modelCatalog.pickProfileForTier(tier, modelService.profiles, modelService.tierOverrides),
    sessionRepo: {
      insertSession: (s) => store.insertSession(s),
      getSession: (id) => store.getSession(id)
    },
    messageRepo: {
      list: (sessionId) => store.listMessages(sessionId),
      append: (m) => {
        store.insertMessage(m.id, m.sessionId, m.text, m.createdAt, m.role, {
          type: m.type,
          // Structured tool-call/tool-result payload, so a later turn can replay the step
          // as native function-calling instead of degrading it to text.
          data: m.data,
          // Tool-step rows and the user turn are static; assistant prose follows the
          // open → markStreaming → settle lifecycle below. Keep assistant→complete for any
          // code path that still appends a text row directly.
          streamStatus: m.role === 'assistant' && (m.type ?? 'text') === 'text' ? 'complete' : 'settled',
          // Carry a per-message context override through to storage (absent ⇒ registry default).
          includeInContext: m.includeInContext
        });
        embeddingIndexer.kick(); // enqueue the new message for background embedding
      },
      // Open a text segment's row as `pending` at its first token so a mid-turn /messages refetch
      // exposes a live row with a subscription `source` (rowToMessage reconstructs it for live rows).
      open: (m) =>
        store.insertMessage(m.id, m.sessionId, m.text, m.createdAt, m.role, {
          type: m.type,
          streamStatus: 'pending',
          includeInContext: m.includeInContext
        }),
      markStreaming: (sessionId, messageId) => {
        store.setGenStatus(sessionId, messageId, 'streaming', new Date().toISOString());
      },
      // Settle the open row in place. No repositioning needed: a segment is opened at its first token,
      // i.e. after any tool rows that ran before it, so it already sorts correctly. Returns whether a
      // row was updated (false ⇒ the caller appends instead — e.g. a non-streaming block turn).
      settle: (m, status) =>
        store.setGenStatus(m.sessionId, m.id, status, new Date().toISOString(), {
          text: m.text,
          data: m.data,
          type: m.type
        })
    },
    defaultModel: cfg.model.default || 'default',
    userId: cfg.principal?.id,
    sandboxRoots,
    contextLimit,
    persistRawToolOutput,
    maxToolResultChars: ctxCfg.toolOutput.maxChars,
    // Record each turn's REAL usage into the session + the global ledger, and compute its real
    // cost from the catalog price (cache-aware). Uses the configured default model for pricing;
    // money is never inferred from estimated tokens.
    recordTurnUsage: defaultSpec
      ? (sessionId, usage) => {
          // Price + attribute to the model that ACTUALLY served the turn (the router stamps it on
          // usage) — defaultSpec is only the fallback when the router didn't report one. Without
          // this, a fallback turn is mispriced and booked against the wrong ledger row.
          const provider = usage.provider ?? defaultSpec.provider;
          const modelId = usage.modelId ?? defaultSpec.modelId;
          const price = modelCatalog.lookupPrice(provider, modelId);
          // Prefer the provider's REAL reported cost (e.g. OpenRouter usage accounting) over a
          // catalog-price estimate; computeCost uses it verbatim as the authoritative source.
          const cost = computeCost(usage, price, usage.costUsd);
          if (sessionId.startsWith('ses_')) store.addUsage(sessionId, usage, cost.usd ?? 0);
          store.recordLedger(provider, modelId, 'chat', usage, cost.usd ?? 0);
          // The assistant turn's text settled outside messageRepo.append — index it now.
          embeddingIndexer.kick();
          return cost;
        }
      : undefined,
    context,
    evictedTokens,
    handoffNudgeFraction: ctxCfg.handoffNudge.enabled ? ctxCfg.handoffNudge.atFraction : undefined,
    history,
    // Prompt-cache the static system+tools prefix (no-op for non-Anthropic models).
    cacheSystemPrompt: true,
    // User-editable SOUL/AGENT/USER blocks from the workspace whitelist. Resolved per-turn so the
    // reload watchers' edits take effect without rebuilding the agent.
    promptSlots: (sessionId) => workspacePromptSlots(sessionId),
    // Ambient context the model can't introspect: rendered into the system prompt so it knows
    // "when/where" it is running. agent-core stays host-agnostic; the daemon supplies the facts.
    environment: {
      date: new Date().toISOString().slice(0, 10),
      os: process.platform,
      cwd: sandboxRoots?.[0] ?? paths.workspace,
      sandbox: sandboxRoots?.length ? sandboxRoots.join(', ') : 'unrestricted'
    },
    gate,
    hooks: hookRunner,
    // Vouch for a hook's model override: a configured profile alias or a "provider:model" spec.
    isModelAllowed: (m) => modelService.profiles.some((p) => p.alias === m) || m.includes(':'),
    // Per-agent budget defaults from the default agent config row (if one is set as default).
    ...(defaultAgentCfg
      ? {
          maxTurns: defaultAgentCfg.maxTurns,
          maxThinkingTokens: defaultAgentCfg.maxThinkingTokens,
          maxBudgetUsd: defaultAgentCfg.maxBudgetUsd
        }
      : {})
  });

  return { agent, history };
}

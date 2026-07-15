import type { Event, GenerationParams, Hooks, SessionId } from '@monad/protocol';
import type { FileObservationStore, Tool, ToolBackends, ToolGate } from '#/capabilities/tools/types.ts';
import type { ContextEngine } from './context/index.ts';
import type { HistoryProvider } from './history.ts';
import type { AgentLoopDeps, LoadedSkill, MessageRepo, SkillTier, ToolSearchConfig } from './loop/index.ts';
import type { Memory } from './memory/index.ts';
import type { ModelRouter } from './model/index.ts';
import type { AgentEnvironment, UserPromptSlots } from './prompts.ts';
import type { SessionRepo } from './session/index.ts';

import { runSubagent } from '#/capabilities/tools/registry/delegate.ts';
import { register as skillRegister } from '#/capabilities/tools/registry/skill.ts';
import { AgentLoop, InMemoryMessageRepo, PromptReplayCache } from './loop/index.ts';
import { InMemoryMemory } from './memory/index.ts';
import { SessionManager } from './session/index.ts';

export * from './context/budget.ts';
export * from './context/estimate.ts';
export * from './context/eviction.ts';
export * from './context/index.ts';
export * from './history.ts';
export * from './loop/index.ts';
export * from './memory/index.ts';
export * from './model/cost.ts';
export * from './model/gateway/index.ts';
export * from './model/index.ts';
export * from './model/provider.ts';
export * from './observation.ts';
export * from './prompts.ts';
export * from './session/index.ts';

export interface AgentConfig {
  model?: ModelRouter;
  memory?: Memory;
  /** The agent's base tools. A function is resolved live (per turn + on each `agent.tools` read), so
   *  the daemon can pass `() => [...registry.tools.values(), …]` and a hot-installed atom-pack/MCP
   *  tool reaches the running agent WITHOUT a rebuild — same live-read contract as `skills`/`instructions`. */
  tools?: Tool[] | (() => Tool[]);
  /** Monotonic version that bumps whenever the `tools` set changes. When provided, the agent memoizes
   *  its composed tool list and only rebuilds on a version change — so an unchanged tool set costs no
   *  per-turn allocation (the daemon passes `() => registry.toolRevision`). Absent → recompute always. */
  toolsVersion?: () => number;
  sessionRepo: SessionRepo;
  messageRepo?: MessageRepo;
  defaultModel?: string;
  /** Principal id for observability span attribution (Phoenix user.id). In-process telemetry only. */
  userId?: string;
  sandboxRoots?: string[];
  /** Durable per-session file observations used by file tools. */
  fileObservations?: FileObservationStore;
  /** Active model's context-window size; enables per-turn `context.usage` breakdowns. */
  contextLimit?: number;
  /** Records each turn's real usage (session + global ledger) and returns its real cost. Injected
   *  by the daemon (store + price catalog); absent → no usage/cost accounting. */
  recordTurnUsage?: AgentLoopDeps['recordTurnUsage'];
  /** Keeps each turn's prompt within the window (truncate/summarize). Default: passthrough. */
  context?: ContextEngine;
  /** Durable bounded-load history strategy (summary boundary). Replaces the full-load path. */
  history?: HistoryProvider;
  /** Prompt-cache the static system+tools prefix (Anthropic; ignored elsewhere). */
  cacheSystemPrompt?: boolean;
  /** Base behavior template for the system prompt. Default: DEFAULT_SYSTEM_PROMPT. A function is
   * resolved per-turn so the daemon can hot-reload template overrides without rebuilding. */
  instructions?: string | ((sessionId?: SessionId) => string | undefined);
  /** User-editable prompt slots (e.g. SOUL/AGENT/USER), resolved per-turn so workspace or per-agent
   * files hot-reload without rebuilding the agent. */
  promptSlots?: UserPromptSlots | ((sessionId?: SessionId) => UserPromptSlots | undefined);
  /** Ambient run context (date/cwd/os/sandbox…) rendered into the system prompt. */
  environment?: AgentEnvironment;
  /** Absent → high-risk tools are denied. */
  gate?: ToolGate;
  /** Lifecycle hooks (command + atom-pack), run at session/prompt/tool/turn junctures. Absent →
   *  NO_HOOKS (every call site is a no-op fast path). */
  hooks?: Hooks;
  /** Validates a UserPromptSubmit hook's `modelOverride`. Absent → accept any. */
  isModelAllowed?: (model: string) => boolean;
  /** When any skill is model-invocable, createAgent appends the `skill` loader tool automatically. */
  skills?: LoadedSkill[];
  /**
   * Resolve a `context: fork` skill's declared capability tier to a concrete model id.
   * Injected by the daemon, which ranks profiles by cost. Returning undefined falls back
   * to the parent's default model.
   */
  resolveTier?: (tier: SkillTier) => string | undefined;
  /** When set, switches to deferred tool-search mode above the configured token threshold:
   *  the model sees only builtin tools + tool_search + tool_call, and uses tool_search to
   *  find and tool_call to execute MCP tools on demand. */
  toolSearchConfig?: ToolSearchConfig;
  /** Max tool-calling turns per run. Absent → unlimited. */
  maxTurns?: number;
  /** Max thinking/reasoning tokens per model step. Absent → profile's reasoningEffort default. */
  maxThinkingTokens?: number;
  /** Max USD cost per run; the loop stops when accumulated cost exceeds this. Absent → unlimited. */
  maxBudgetUsd?: number;
}

export interface Agent {
  readonly model: ModelRouter;
  readonly memory: Memory;
  readonly tools: Tool[];
  readonly sessions: SessionManager;
  loop(
    emit: (event: Event) => void,
    opts?: {
      backends?: ToolBackends;
      toolFilter?: (toolName: string) => boolean;
      ambientContext?: string;
      extraTools?: Tool[];
      /** Per-run sandbox roots override (ACP trusts the client's cwd + additionalDirectories). */
      sandboxRoots?: string[];
      /** The session's bound agent (`session.agentIds[0]`); threaded to the sandbox seam for
       *  per-agent VM reuse. Absent → the seam keys on sessionId. */
      agentId?: string;
      /** Per-run model override (resolved profile alias or "provider:model"). Set from a session's
       *  `/model` choice; falls back to the agent's defaultModel. */
      modelOverride?: string;
      /** Per-run generation parameter overrides supplied by the session. */
      generationParams?: GenerationParams;
      /** Default working directory for shell commands. Absent → sandboxRoots?.[0]. */
      defaultCwd?: string;
      /** Project-local skills discovered from session.cwd/.monad/skills/ — merged with global skills
       *  for this loop only; global skill hot-reload still applies to the shared portion. */
      extraSkills?: LoadedSkill[];
    }
  ): AgentLoop;
}

/** Placeholder router for an agent built without a model — lets construction succeed (e.g. in tests)
 *  but fails loudly if a turn actually runs. The daemon always injects a real GatewayModelRouter. */
const NO_MODEL: ModelRouter = {
  // biome-ignore lint/correctness/useYield: throw-only stub
  async *stream(): AsyncIterable<never> {
    throw new Error('createAgent: no model configured — inject config.model (e.g. GatewayModelRouter)');
  },
  async complete(): Promise<never> {
    throw new Error('createAgent: no model configured — inject config.model (e.g. GatewayModelRouter)');
  }
};

export function createAgent(config: AgentConfig): Agent {
  // Un-configured model fails only when a turn actually runs (see NO_MODEL).
  const model = config.model ?? NO_MODEL;
  const memory = config.memory ?? new InMemoryMemory();
  const skills = config.skills ?? [];
  // Base tools resolved live (a plain array is wrapped as a constant getter), so the daemon's
  // registry mutations (a hot-installed atom-pack/MCP tool) show up without rebuilding the agent.
  const cfgTools = config.tools;
  const resolveBaseTools: () => Tool[] = typeof cfgTools === 'function' ? cfgTools : () => cfgTools ?? [];
  const defaultModel = config.defaultModel ?? '';
  const runFork = async (
    body: string,
    ctx: { sessionId: string; sandboxRoots?: string[]; backends?: ToolBackends },
    tier?: SkillTier,
    name?: string
  ): Promise<string> => {
    // Resolve the skill's declared tier to a concrete model; fall back to the parent default
    // when no tier is declared or the routing layer can't place it.
    const forkModel = (tier && config.resolveTier?.(tier)) || defaultModel;
    // Forked subagents strip delegation and skill_manage so they can't recurse or rewrite skills.
    // Resolved live so a fork sees a just-installed tool too.
    const forkTools = resolveBaseTools().filter((t) => t.name !== 'agent_delegate' && t.name !== 'skill_manage');
    const hooks = config.hooks;
    const hookCwd = ctx.sandboxRoots?.[0] ?? '';
    // Before/AfterSubagent fire here — the single fork-subagent chokepoint — so they cover BOTH an
    // explicit `/name` fork and a fork skill the model auto-loads via the `skill` tool. BeforeSubagent
    // may inject context into the fork; AfterSubagent fires on success AND failure (`ok`/`error`) and
    // may rewrite the result (e.g. redact) via `mutatedText` before it surfaces to the parent turn.
    let forkBody = body;
    if (hooks) {
      const pre = await hooks.run({
        event: 'BeforeSubagent',
        sessionId: ctx.sessionId,
        cwd: hookCwd,
        timestamp: new Date().toISOString(),
        subagentName: name
      });
      if (pre.additionalContext.length) forkBody = `${pre.additionalContext.join('\n\n')}\n\n${body}`;
    }
    const deps = {
      model,
      tools: forkTools,
      defaultModel: forkModel,
      userId: config.userId,
      gate: config.gate,
      fileObservations: config.fileObservations,
      context: config.context,
      contextLimit: config.contextLimit,
      forkDepth: 1,
      // Subagent reasoning fires its own BeforeModel/AfterModel/tool/turn events, tagged `subagent`.
      hooks: config.hooks,
      subagentCaller: { agentName: name }
    };
    let result: string;
    try {
      result = await runSubagent(deps, forkBody, ctx);
    } catch (err) {
      if (hooks) {
        await hooks.run({
          event: 'AfterSubagent',
          sessionId: ctx.sessionId,
          cwd: hookCwd,
          timestamp: new Date().toISOString(),
          subagentName: name,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      throw err;
    }
    if (!hooks) return result;
    const d = await hooks.run({
      event: 'AfterSubagent',
      sessionId: ctx.sessionId,
      cwd: hookCwd,
      timestamp: new Date().toISOString(),
      subagentName: name,
      subagentResult: result,
      ok: true
    });
    return d.effectiveText ?? result;
  };
  // Compose the model-facing tool list from the LIVE base tools + the auto skill loader. Called per
  // turn and on each `agent.tools` read, so a registry mutation appears without rebuilding the agent.
  // `skills` is read live by the skill tool (the daemon mutates the array in place), so only the skill
  // tool's PRESENCE (any model-invocable skill) — not its content — affects the composed array.
  //
  // Memoized on `toolsVersion` for the common no-session-skills path: when nothing was installed or
  // removed, the same array reference is returned with zero allocation (the skill tool already reads
  // skills live, so a skill-content change needs no rebuild). A version bump (install/remove) or a
  // change in skill-tool presence invalidates it.
  let memo: { version: number; hasSkill: boolean; result: Tool[] } | undefined;
  const composeTools = (extraSkills: LoadedSkill[]): Tool[] => {
    const allSkills = extraSkills.length ? [...skills, ...extraSkills] : skills;
    const hasSkill = allSkills.some((s) => s.modelInvocable !== false);
    const version = extraSkills.length === 0 ? config.toolsVersion?.() : undefined;
    if (version !== undefined && memo && memo.version === version && memo.hasSkill === hasSkill) {
      return memo.result;
    }
    const base = resolveBaseTools();
    const result = hasSkill
      ? [
          ...base,
          ...skillRegister({ getSkills: () => (extraSkills.length ? [...skills, ...extraSkills] : skills), runFork })
        ]
      : base;
    if (version !== undefined) memo = { version, hasSkill, result };
    return result;
  };
  const sessions = new SessionManager(config.sessionRepo);
  const messageRepo = config.messageRepo ?? new InMemoryMessageRepo();
  // Shared across every per-turn loop so the transcript isn't re-replayed from scratch each turn.
  const promptCache = new PromptReplayCache();

  return {
    model,
    memory,
    // Live getter: a hot-installed tool (registry mutation) is visible on the next read.
    get tools() {
      return composeTools([]);
    },
    sessions,
    loop: (emit, opts) => {
      // Compose from the LIVE base each turn; extraSkills (session-local) are fixed for this loop.
      const extraSkills = opts?.extraSkills ?? [];
      const loopSkills = extraSkills.length ? [...skills, ...extraSkills] : skills;
      const baseLoopTools = composeTools(extraSkills);
      // When deferred tool-search is configured, append the meta-tools so executeToolCall can find
      // them; toolSpecs() controls whether they're actually shown to the model on a given turn.
      const cfg = config.toolSearchConfig;
      const loopTools = cfg ? [...baseLoopTools, cfg.searchTool, cfg.callTool] : baseLoopTools;
      return new AgentLoop({
        model,
        tools: loopTools,
        messages: messageRepo,
        promptCache,
        defaultModel: opts?.modelOverride ?? defaultModel,
        generationParams: opts?.generationParams,
        userId: config.userId,
        emit,
        sandboxRoots: opts?.sandboxRoots ?? config.sandboxRoots,
        agentId: opts?.agentId,
        backends: opts?.backends,
        fileObservations: config.fileObservations,
        toolFilter: opts?.toolFilter,
        ambientContext: opts?.ambientContext,
        extraTools: opts?.extraTools,
        contextLimit: config.contextLimit,
        recordTurnUsage: config.recordTurnUsage,
        context: config.context,
        history: config.history,
        cacheSystemPrompt: config.cacheSystemPrompt,
        instructions: config.instructions,
        promptSlots: config.promptSlots,
        environment: config.environment,
        gate: config.gate,
        hooks: config.hooks,
        isModelAllowed: config.isModelAllowed,
        skills: loopSkills,
        runFork,
        maxTurns: config.maxTurns,
        maxThinkingTokens: config.maxThinkingTokens,
        maxBudgetUsd: config.maxBudgetUsd,
        toolSearchConfig: cfg
      });
    }
  };
}

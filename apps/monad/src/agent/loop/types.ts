import type {
  Cost,
  Event,
  Hooks,
  MessageStream,
  MessageType,
  ModelPrice,
  SessionId,
  ChatMessage as WireChatMessage
} from '@monad/protocol';
import type { Tool, ToolBackends, ToolGate } from '@/capabilities/tools/types.ts';
import type { ContextEngine } from '../context/index.ts';
import type { HistoryProvider } from '../history.ts';
import type { ModelRouter, ModelUsage } from '../model/index.ts';
import type { AgentEnvironment, UserPromptSlots } from '../prompts.ts';
import type { PromptReplayCache } from './replay.ts';

/** A chat message as the loop sees it: a minimal persisted row view derived from @monad/protocol. */
export type ChatMessage = Pick<WireChatMessage, 'role' | 'text' | 'createdAt' | 'data' | 'includeInContext'> & {
  id: string;
  sessionId: string;
  type?: MessageType;
  /** In-flight rows have no settled content yet, so replayHistory skips them from the prompt. */
  stream?: MessageStream;
};

export interface MessageRepo {
  list(sessionId: string): ChatMessage[] | Promise<ChatMessage[]>;
  append(message: ChatMessage): void | Promise<void>;
  /**
   * Streaming-message lifecycle. Store-backed repos open an assistant segment on first token, mark
   * it streaming, and settle it in place. In-memory/test repos can omit these and always append.
   */
  open?(message: ChatMessage): void | Promise<void>;
  markStreaming?(sessionId: string, messageId: string): void | Promise<void>;
  settle?(message: ChatMessage, status: 'complete' | 'error'): boolean | Promise<boolean>;
}

/** Attached to the current user turn only; persisted history replay will not resend it. */
export interface ImageAttachment {
  image: Uint8Array;
  mediaType: string;
}

export interface AgentLoopDeps {
  model: ModelRouter;
  tools: Tool[];
  messages: MessageRepo;
  defaultModel: string;
  /** Principal id for observability span attribution. In-process telemetry only. */
  userId?: string;
  emit(event: Event): void;
  sandboxRoots?: string[];
  /** Execution backends for this run. ACP sessions supply delegating backends. */
  backends?: ToolBackends;
  /** Default working directory for shell commands when not overridden per-call. */
  defaultCwd?: string;
  /** Per-run predicate keeping only the named tools. */
  toolFilter?: (toolName: string) => boolean;
  /** Per-run additive tools, such as session-scoped MCP tools. */
  extraTools?: Tool[];
  /** Absent means high-risk tools are denied fail-closed. */
  gate?: ToolGate;
  /** Lifecycle hooks. Absent means NO_HOOKS. */
  hooks?: Hooks;
  /** Tags hook calls from forked/delegated subagents. */
  subagentCaller?: { agentName?: string };
  /** Validates a UserPromptSubmit hook's modelOverride before it is applied. */
  isModelAllowed?: (model: string) => boolean;
  maxStopContinues?: number;
  /** Max tool-calling turns per run. Absent → unlimited. */
  maxTurns?: number;
  /** Max thinking/reasoning tokens per model step. Absent → profile's reasoningEffort default. */
  maxThinkingTokens?: number;
  /** Max USD cost per run; the loop stops when accumulated cost exceeds this. Absent → unlimited. */
  maxBudgetUsd?: number;
  /** Compute real USD cost from usage + price. Injected so the loop can check budget. */
  computeCost?: (usage: ModelUsage | undefined, price: ModelPrice | undefined, providerUsd?: number) => Cost;
  /** Max chars of a single tool result fed back to the model. */
  maxToolResultChars?: number;
  /** Active model context-window size for context.usage events. */
  contextLimit?: number;
  /** Records one turn's real provider usage and returns computed cost for agent.message. */
  recordTurnUsage?: (sessionId: SessionId, usage: ModelUsage, modelId: string) => Cost | undefined;
  context?: ContextEngine;
  /** Durable, bounded-load history strategy. */
  history?: HistoryProvider;
  /** Cross-turn cache of replayed message history, shared by per-turn AgentLoop instances. */
  promptCache?: PromptReplayCache;
  /** Marks the static system+tools prefix with a prompt-cache breakpoint. */
  cacheSystemPrompt?: boolean;
  /** Base behavior template for the system prompt. */
  instructions?: string | ((sessionId?: SessionId) => string | undefined);
  /** User-editable prompt slots (e.g. SOUL/AGENT/USER), resolved per turn. */
  promptSlots?: UserPromptSlots | ((sessionId?: SessionId) => UserPromptSlots | undefined);
  environment?: AgentEnvironment;
  /** Dynamic per-turn context appended to the last user message. */
  ambientContext?: string;
  /** Skills available this turn. */
  skills?: LoadedSkill[];
  /** Runs a context: fork skill body as an isolated subagent. */
  runFork?: (
    body: string,
    ctx: { sessionId: string; sandboxRoots?: string[]; backends?: ToolBackends },
    tier?: SkillTier,
    name?: string
  ) => Promise<string>;
  /** When set, switches to deferred tool-search mode above the configured token threshold. */
  toolSearchConfig?: ToolSearchConfig;
}

export interface ToolSearchConfig {
  /** The tool_search meta-tool. */
  searchTool: Tool;
  /** Routes by name to any registered tool. */
  callTool: Tool;
  /** Tool names always exposed directly to the model. */
  builtinToolNames: ReadonlySet<string>;
  /** Schema token threshold above which deferred mode activates. */
  threshold?: number;
  /** Current tool revision for invalidating cached tool specs. */
  getToolRevision?: () => number;
}

/** Skill names a tier, not a model; the routing layer resolves it to a concrete model. */
export type SkillTier = 'fast';

/** Structurally a subset of @monad/home's Skill so the daemon can pass discovered skills through. */
export interface LoadedSkill {
  name: string;
  description: string;
  version?: string;
  icon?: string;
  /** Rendered SKILL.md body. */
  body: string;
  /** Absolute skill directory anchoring bundled resource files. */
  dir?: string;
  /** false excludes it from model-facing skill listing and the skill tool. */
  modelInvocable?: boolean;
  /** false means not invocable via /name. */
  userInvocable?: boolean;
  /** Space/comma-separated tool patterns pre-approved while this skill is active this turn. */
  allowedTools?: string;
  /** true means run the body as an isolated subagent and return its result. */
  fork?: boolean;
  /** Capability tier for the forked subagent's model. */
  tier?: SkillTier;
}

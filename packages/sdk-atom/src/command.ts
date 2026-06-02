// Command authoring surface — the `command` atom of the unified atom pack SDK. A command is a
// host-run slash command (no LLM turn). First-party built-ins and third-party atom pack commands use
// THIS same surface (defineCommand); the core CommandRegistry gives built-ins priority and forbids
// an atom pack from shadowing a built-in name.
//
// Like ChannelContext, CommandRunContext is deliberately NARROW: it exposes verbs (new/switch/reset/
// compact/model), never the daemon's store/agent/Event. The narrow surface IS the security boundary.
// Commands RETURN a CommandResult; the host turns it into a directive message — so Event stays out
// of the SDK.

import type { Translate } from '@monad/i18n';
import type { CommandSpec } from '@monad/protocol';

export type { CommandKind, CommandSource, CommandSpec } from '@monad/protocol';

export type CommandLog = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

/** One session as seen by a command (no raw session record). */
export interface CommandSessionInfo {
  sessionId: string;
  label?: string;
  active: boolean;
}

/** One model profile a command may switch to. */
export interface CommandModelInfo {
  alias: string;
  provider: string;
  modelId: string;
  current: boolean;
}

/** The narrow capability surface a command runs against. The host backs every method with full
 *  access; the command only sees these verbs. */
/** Per-scope outcome of a /consolidate-memory pass (fact count before → after the dedup/merge). */
export interface ConsolidateMemorySummary {
  scope: string;
  before: number;
  after: number;
}

/** Outcome of a /consolidate-graph pass over the L2 knowledge graph. */
export interface GraphConsolidateSummary {
  sessionsExtracted: number;
  nodes: number;
  edges: number;
  prunedEdges: number;
}

/** Outcome of a manual /compact pass. */
export interface CompactSummary {
  compacted: number;
  summary?: string;
}

export interface CommandRunContext {
  readonly sessionId: string;
  readonly principalId: string;
  /** The raw argument string after the command name (untrimmed remainder). */
  readonly args: string;

  /** Session lifecycle. */
  newSession(label?: string): Promise<{ sessionId: string }>;
  listSessions(): Promise<CommandSessionInfo[]>;
  /** Switch the active session by 1-based index or session id; null when no match. */
  switchSession(target: string): Promise<CommandSessionInfo | null>;

  /** Context management. */
  resetHistory(): Promise<{ clearedCount: number }>;
  compact(): Promise<CompactSummary>;
  /** Dedup/merge/correct every durable memory scope (the built-in backend's manual cleanup pass). */
  consolidateMemory(): Promise<ConsolidateMemorySummary[]>;
  /** Build/update the L2 knowledge graph from recent conversations (manual trigger). */
  consolidateGraph(): Promise<GraphConsolidateSummary>;

  /** Model selection (per-session override). */
  listModels(): Promise<CommandModelInfo[]>;
  /** Switch the model for this session; rejects if the alias is unknown. */
  setModel(alias: string): Promise<void>;

  /** The session's shared working folder (absent → daemon default). All agents in the conversation
   *  — including delegated subagents — resolve fs/shell paths against it. */
  getWorkdir(): Promise<{ path?: string }>;
  /** Set the shared working folder to an absolute path (empty string clears it); rejects if the path
   *  is not an existing directory. Returns the resolved path. */
  setWorkdir(path: string): Promise<{ path?: string }>;

  /** The full advertised command set (built-ins + atom pack commands + skills) — backs /help. */
  listCommands(): Promise<CommandSpec[]>;

  /** Summarize the current session and start a new one, carrying a structured context block forward.
   *  The summary is generated via LLM (fast model). Returns the new session id. */
  handoff(initialTask?: string): Promise<{ sessionId: string }>;

  /** Localize a message id against the active locale. Built-in commands use this for every reply;
   *  third-party commands may pass their own ids (unknown ids fall back to the id string). */
  t: Translate;

  log: CommandLog;
}

/** Structured side-effect a rich client can react to (navigate, clear view). Dumb clients (channel)
 *  ignore it and just show `message`. */
export type CommandEffect =
  | { type: 'session-created'; sessionId: string }
  | { type: 'session-switched'; sessionId: string }
  | { type: 'history-reset' }
  | { type: 'compacted'; compacted: number; summary?: string }
  | { type: 'model-changed'; alias: string }
  | { type: 'workdir-changed'; path?: string }
  | { type: 'view-clear' }
  | { type: 'help'; commands: CommandSpec[] };

export interface CommandResult {
  /** Human-readable reply, rendered by every client (channel sends this verbatim). */
  message?: string;
  /** Optional structured effect for rich clients. */
  effect?: CommandEffect;
  data?: unknown;
}

/** Who may run a command. 'everyone' (default) = any principal in the session; 'owner' = only the
 *  daemon owner (e.g. blocks a channel guest from running a sensitive atom pack command). */
export type CommandAccess = 'everyone' | 'owner';

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  /** Optional i18n message id for `description`. When the registry lists commands with a translator,
   *  the localized text replaces `description`; `description` remains the authoring-language default. */
  descriptionKey?: string;
  argHint?: string;
  /** Routes through the host's tool-approval/oversight gate before running. */
  highRisk?: boolean;
  /** Who may run it (default 'everyone'). 'owner' commands are denied to non-owner callers. */
  access?: CommandAccess;
  /** Allow running WHILE an agent turn is streaming for the session. Default false: the host rejects
   *  the command with a "busy" reply so it can't race the in-flight run (clear history, swap model…). */
  duringTurn?: boolean;
  run(ctx: CommandRunContext, args: string): Promise<CommandResult>;
}

/** Identity helper that pins the CommandDefinition shape at authoring time (the defineChannel analog). */
export function defineCommand(def: CommandDefinition): CommandDefinition {
  return def;
}

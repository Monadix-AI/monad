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
import type { CommandArg, CommandItem, CommandItemType, CommandSource, CommandSubcommand } from '@monad/protocol';

export type { CommandArg, CommandItem, CommandItemType, CommandSource, CommandSubcommand };

export type CommandSubcommandDefinition = Omit<CommandSubcommand, 'aliases'> & { aliases?: string[] };

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

/** Outcome of a /consolidate pass over the layered memory pipeline, run up to `level`
 *  (1 = L1 facts, 2 = + L2 graph, 3 = + L3 laws). Layers not reached report 0. */
export interface ConsolidateSummary {
  level: number;
  l1Scopes: number;
  nodes: number;
  edges: number;
  prunedEdges: number;
  laws: number;
  lawScopes: number;
}

/** One law matched by a /why query, traced to its grounding: the facts it generalizes, the graph
 *  relations it rests on, and the source messages those relations came from. */
export interface BeliefMatch {
  statement: string;
  confidence: number;
  facts: string[];
  relations: string[];
  sources: string[];
}
export interface BeliefExplanation {
  matches: BeliefMatch[];
}

/** Outcome of a /check-memory pass: how many laws were flagged as contradicted by a current fact. */
export interface ContradictionCheckSummary {
  flagged: number;
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
  /** Archive the current session. */
  archiveSession(): Promise<void>;

  /** Context management. */
  resetHistory(): Promise<{ clearedCount: number }>;
  compact(): Promise<CompactSummary>;
  /** Run the layered-memory consolidation pipeline up to `level` (defaults to the configured
   *  memory.level): L1 fact dedup, then L2 graph, then L3 laws. */
  consolidate(level?: number): Promise<ConsolidateSummary>;
  /** Trace why the agent believes something: match the query against stored laws and return each
   *  match's grounding (facts, relations, source messages). */
  explainBelief(query: string): Promise<BeliefExplanation>;
  /** Flag laws contradicted by a current fact (suppressed from recall until re-derived). */
  checkMemory(): Promise<ContradictionCheckSummary>;

  /** Model selection (per-session override). */
  listModels(): Promise<CommandModelInfo[]>;
  /** Switch the model for this session; rejects if the alias is unknown. */
  setModel(alias: string): Promise<void>;
  /** Set or clear the reasoning effort override for this session. */
  setEffort(effort?: string): Promise<void>;

  /** The session's shared working folder (absent → daemon default). All agents in the conversation
   *  — including delegated subagents — resolve fs/shell paths against it. */
  getWorkdir(): Promise<{ path?: string }>;
  /** Set the shared working folder to an absolute path (empty string clears it); rejects if the path
   *  is not an existing directory. Returns the resolved path. */
  setWorkdir(path: string): Promise<{ path?: string }>;

  /** The full advertised command set (built-ins + atom pack commands + skills) — backs /help. */
  listCommands(): Promise<CommandItem[]>;

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
  | { type: 'model-effort-changed'; effort?: string }
  | { type: 'workdir-changed'; path?: string }
  | { type: 'view-clear' }
  | { type: 'help'; commands: CommandItem[] };

export interface CommandResult {
  /** Human-readable reply, rendered by every client (channel sends this verbatim). */
  message?: string;
  /** Optional structured effect for rich clients. */
  effect?: CommandEffect;
  data?: unknown;
}

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  /** Optional i18n message id for `description`. When the registry lists commands with a translator,
   *  the localized text replaces `description`; `description` remains the authoring-language default. */
  descriptionKey?: string;
  /** Optional product grouping for command discovery/help surfaces. */
  group?: string;
  argHint?: string;
  /** Structured positional arguments for discovery/autocomplete. Execution still receives raw args. */
  args?: CommandArg[];
  /** Optional one-level subcommands for discovery/autocomplete. Execution still receives raw args. */
  subcommands?: CommandSubcommandDefinition[];
  /** Routes through the host's tool-approval/oversight gate before running. */
  highRisk?: boolean;
  /** Allow running WHILE an agent turn is streaming for the session. Default false: the host rejects
   *  the command with a "busy" reply so it can't race the in-flight run (clear history, swap model…). */
  duringTurn?: boolean;
  run(ctx: CommandRunContext, args: string): Promise<CommandResult>;
}

/** Identity helper that pins the CommandDefinition shape at authoring time (the defineChannel analog). */
export function defineCommand(def: CommandDefinition): CommandDefinition {
  return def;
}

// Tool authoring surface — the `Tool` type and its supporting backends/context for monad's
// first-party, built-in tools. Tools are NOT an atom kind: they ship with the daemon and are never
// contributed by atom packs, so this surface lives here in apps/monad — the SDK (@monad/sdk-atom)
// carries no tool types and tools do not go through it. The one exception is the `ProviderToolHint`
// provider-binding type imported below. Channels/providers do not depend on this surface.

import { z } from 'zod';

export type ToolResultPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string | Uint8Array; mediaType?: string };

const toolResultPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    image: z.union([z.string(), z.instanceof(Uint8Array)]),
    mediaType: z.string().optional()
  })
]);

export type ToolDisplayContent =
  | {
      type: 'diff';
      path: string;
      beforeText: string | null;
      afterText: string;
      diff?: string;
      diffStat?: { added: number; removed: number };
      truncated?: boolean;
      warning?: string;
    }
  | {
      type: 'multi_diff';
      summary?: { added: number; removed: number; succeeded: number; failed: number; total: number };
      files: Array<{
        path: string;
        status: 'ok' | 'error';
        display?: Extract<ToolDisplayContent, { type: 'diff' }>;
        error?: string;
        operation?: string;
        newPath?: string;
      }>;
    }
  | { type: 'text'; text: string };

const toolDisplayContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('diff'),
    path: z.string(),
    beforeText: z.string().nullable(),
    afterText: z.string(),
    diff: z.string().optional(),
    diffStat: z.object({ added: z.number(), removed: z.number() }).optional(),
    truncated: z.boolean().optional()
  }),
  z.object({
    type: z.literal('multi_diff'),
    summary: z
      .object({
        added: z.number(),
        removed: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        total: z.number()
      })
      .optional(),
    files: z.array(
      z.object({
        path: z.string(),
        status: z.enum(['ok', 'error']),
        display: z
          .object({
            type: z.literal('diff'),
            path: z.string(),
            beforeText: z.string().nullable(),
            afterText: z.string(),
            diff: z.string().optional(),
            diffStat: z.object({ added: z.number(), removed: z.number() }).optional(),
            truncated: z.boolean().optional(),
            warning: z.string().optional()
          })
          .optional(),
        error: z.string().optional(),
        operation: z.string().optional(),
        newPath: z.string().optional()
      })
    )
  }),
  z.object({ type: z.literal('text'), text: z.string() })
]);

export type ToolModelContent = string | ToolResultPart[];
const toolModelContentSchema = z.union([z.string(), z.array(toolResultPartSchema)]);

export interface ToolResult<Metadata = unknown> {
  modelContent: ToolModelContent;
  displayContent?: ToolDisplayContent;
  metadata: Metadata;
}

export const toolResultSchema = z.object({
  modelContent: toolModelContentSchema,
  displayContent: toolDisplayContentSchema.optional(),
  metadata: z.unknown()
});

export function toolResult<Metadata>(
  metadata: Metadata,
  opts: {
    modelContent?: ToolModelContent;
    displayContent?: ToolDisplayContent;
  } = {}
): ToolResult<Metadata> {
  return {
    modelContent: opts.modelContent ?? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)),
    ...(opts.displayContent ? { displayContent: opts.displayContent } : {}),
    metadata
  };
}

/**
 * Structurally compatible with zod schemas but not locked to zod.
 * Tool arguments are attacker-controllable — always validate, never cast.
 */
export interface ToolInputSchema<T = unknown> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
  /**
   * JSON Schema for the input, shown to the model so it knows the argument shape (native
   * function-calling). zod schemas are auto-converted via `z.toJSONSchema`; non-zod schemas
   * implement this to opt in. Absent → the tool exposes no parameter schema to the model.
   */
  toJsonSchema?(): Record<string, unknown>;
}

/**
 * Filesystem execution backend. The default (`createSandboxBackends`) reads/writes the daemon's
 * own disk behind the sandbox path guards; an ACP-delegating backend routes the same operations
 * through the connected editor's `fs/*` reverse-RPC so edits surface as reviewable diffs.
 *
 * When `delegated` is true the editor owns the filesystem and its workspace boundary is the
 * control — monad's sandbox path checks do NOT apply (and writes defer to the editor for approval).
 */
export interface FsBackend {
  readTextFile(path: string, opts?: { offset?: number; limit?: number }): Promise<string>;
  writeTextFile(path: string, content: string): Promise<{ path: string; bytesWritten: number }>;
  deleteFile?(path: string): Promise<{ path: string }>;
  moveFile?(path: string, newPath: string): Promise<{ path: string; newPath: string }>;
  readonly delegated: boolean;
}

export interface TerminalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Command execution backend. Sandbox default spawns on the daemon host; the ACP backend runs
 * the command in the editor's integrated terminal via `terminal/*` reverse-RPC. */
export interface TerminalBackend {
  exec(opts: {
    /** Shell string (wrapped in sh -c / Git Bash -c) OR argv array (exec'd directly, no shell). */
    command: string | string[];
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Extra env vars merged onto the child's inherited environment (the sandbox proxy/HOME overlay
     * still wins). Carries a delegating ACP sub-agent's requested `createTerminal.env`. */
    env?: Record<string, string>;
    /** Called with the full accumulated output as the command runs (live streaming). */
    onChunk?: (output: string) => void;
  }): Promise<TerminalExecResult>;
  readonly delegated: boolean;
}

/** The fs/terminal execution surface a tool call runs against. Always present on a loop-built
 * ToolContext (defaults to the sandbox-backed implementation); the ACP transport swaps in a
 * delegating implementation per session. */
export interface ToolBackends {
  fs: FsBackend;
  terminal: TerminalBackend;
}

export interface FileObservation {
  path: string;
  hash: string;
  coverage: 'full';
  observedAt: string;
  toolCallId?: string;
}

export interface FileObservationStore {
  remember(sessionId: string, observation: FileObservation): void | Promise<void>;
  get(sessionId: string, path: string): FileObservation | null | Promise<FileObservation | null>;
}

import type { Scope } from '@monad/protocol';
import type { ProviderToolHint } from '@monad/sdk-atom';

interface ToolContextSkill {
  name: string;
  description: string;
  body: string;
  dir?: string;
  modelInvocable?: boolean;
  userInvocable?: boolean;
  allowedTools?: string;
  fork?: boolean;
  tier?: string;
}

export interface ToolContext {
  sessionId: string;
  /** The id of this tool call, for correlation/logging. The loop always sets it. */
  toolCallId?: string;
  /**
   * Resolved sandbox roots (see @monad/home resolveEffectiveSandboxMode). `undefined` = unrestricted.
   * fs:* tools MUST call assertPathWithinRoots(path, sandboxRoots) — declaration is not enforcement.
   */
  sandboxRoots?: string[];
  /**
   * fs/terminal execution backends. The loop always populates this (sandbox by default, or a
   * delegating backend for ACP sessions). Optional on the type so direct callers/tests can omit
   * it; tools fall back to a sandbox backend built from `sandboxRoots` when absent.
   */
  backends?: ToolBackends;
  /** Durable per-session file observations used for whole-file write/delete/move guards. */
  fileObservations?: FileObservationStore;
  /** Per-session/per-run tools appended to the base toolset. Used by delegation bridges. */
  extraTools?: Tool[];
  /** Optional filter narrowing the exposed tool set for this run/session. */
  toolFilter?: (toolName: string) => boolean;
  /** Project/session-local skills available to this run. */
  extraSkills?: ToolContextSkill[];
  /** Default working directory for shell commands when the tool call doesn't supply an explicit
   * cwd. Falls back to `sandboxRoots?.[0]` when absent (preserving the pre-cwd behaviour). */
  defaultCwd?: string;
  /** Aborted when the session is cancelled. Long-running tools should honour it (fetch, spawn…). */
  signal?: AbortSignal;
  /** Report streamed partial output while the tool runs (e.g. live shell output). `output` is the
   * full accumulated text so far. The loop wires this to a `tool.progress` event; absent for direct
   * callers/tests. */
  reportProgress?(output: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void;
  /**
   * The approval gate — tools may invoke it mid-run for dynamic access decisions (e.g. path
   * escalation when a file lies outside the sandbox). Absent in direct/test callers.
   */
  gate?: ToolGate;
}

export interface ToolGateRequest {
  tool: string;
  sessionId: string;
  highRisk: boolean;
  input: unknown;
  /** Optional pattern key (from Tool.gateKey) narrowing approval rules below whole-tool, e.g.
   * 'target:host' for code_execute or 'git' for shell_exec. Absent = whole-tool granularity. */
  key?: string;
}

export type ToolGateOutcome = { allow: true } | { allow: false; reason: string };

/** Absent gate + high-risk → denied. */
export type ToolGate = (request: ToolGateRequest) => Promise<ToolGateOutcome>;

export interface Tool<Input = unknown, Metadata = unknown> {
  name: string;
  description: string;
  scopes: Scope[];
  /** send/pay/delete/… ops that drive the human-approval gate. A static shorthand for
   * `needsApproval: () => true`; `needsApproval` (when present) overrides it. */
  highRisk?: boolean;
  /**
   * Per-call approval predicate. When present it decides — instead of `highRisk` — whether
   * this specific input must pass the approval gate (e.g. a write only needs approval when it
   * can escape the sandbox). Receives the validated input and the call context.
   */
  needsApproval?(input: Input, ctx: ToolContext): boolean | Promise<boolean>;
  /**
   * Optional approval-rule key for this input — lets a dangerous tool narrow remembered decisions
   * below whole-tool granularity (e.g. code_execute → 'target:host' vs 'target:sandbox';
   * shell_exec → the command's leading token). Returned via ToolGateRequest.key; the policy engine
   * matches (tool,key) exactly, falling back to a whole-tool rule when this is absent. Pure, no I/O.
   */
  gateKey?(input: Input): string | undefined;
  /**
   * When present, the raw input is parsed at the dispatch boundary and the coerced
   * result is passed to `run`; a parse failure rejects before the gate or `run`.
   */
  inputSchema?: ToolInputSchema<Input>;
  /** Example inputs surfaced to the model to steer tool-call accuracy (cron strings, globs…). */
  inputExamples?: Input[];
  /**
   * Optional provider-native tool binding. When the active provider matches, the model sees the
   * provider's built-in tool (e.g. Anthropic computer-use) instead of this tool's generic schema;
   * `run` still executes the call. Other providers fall back to the generic schema. See
   * ProviderToolHint.
   */
  providerTool?: ProviderToolHint;
  run(input: Input, ctx: ToolContext): Promise<ToolResult<Metadata>>;
}

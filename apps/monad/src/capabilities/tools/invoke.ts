// Tool arguments are attacker-controllable (prompt injection), so this is the single
// seam every tool call passes through: high-risk tools route through the approval gate
// (fail-closed: no gate → denied); sandbox roots are injected into ToolContext so
// resource guards (fs paths, net URLs) can enforce at call time.
// See docs/security-guidelines.md §4.

import type {
  FileObservationStore,
  Tool,
  ToolBackends,
  ToolContext,
  ToolGate,
  ToolResult
} from '#/capabilities/tools/types.ts';

import { toolResultSchema } from '#/capabilities/tools/types.ts';

export class ToolGateDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolGateDeniedError';
  }
}

export class ToolInputError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ToolInputError';
  }
}

export class ToolResultError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ToolResultError';
  }
}

/**
 * Render a schema validation failure into model-readable, field-level guidance so the agent can
 * correct its next tool call instead of re-guessing blindly (tool-step budget is small). Handles
 * a zod-style `{ issues: [{ path, message }] }` error and falls back to the raw message.
 */
function describeSchemaError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`).join('; ');
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface InvokeToolOptions {
  sessionId: string;
  /** The session's bound agent — forwarded into ToolContext.agentId for per-agent VM reuse. */
  agentId?: string;
  sandboxRoots?: string[];
  log: ToolContext['log'];
  gate?: ToolGate;
  /** Aborted when the session is cancelled — forwarded into ToolContext.signal. */
  signal?: AbortSignal;
  /** Correlation id for this call — forwarded into ToolContext.toolCallId. */
  toolCallId?: string;
  /** fs/terminal execution backends — forwarded into ToolContext.backends. Absent → tools
   * fall back to a sandbox backend built from `sandboxRoots`. */
  backends?: ToolBackends;
  /** Per-session durable file observations. */
  fileObservations?: FileObservationStore;
  /** Forwarded into ToolContext.defaultCwd. */
  defaultCwd?: string;
  /** Streamed partial-output sink — forwarded into ToolContext.reportProgress. */
  onProgress?: (output: string) => void;
  /** Force this call through the approval gate regardless of `highRisk`/`needsApproval` — set when a
   * PreToolUse hook returned `ask`, so hook-driven approval reuses the same gate path. */
  forceApproval?: boolean;
}

export async function invokeTool<Input, Metadata>(
  tool: Tool<Input, Metadata>,
  input: Input,
  opts: InvokeToolOptions
): Promise<ToolResult<Metadata>> {
  // Validate before the gate — don't ask a human to approve a malformed call.
  let validated = input;
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolInputError(
        `invalid input for tool "${tool.name}": ${describeSchemaError(parsed.error)}`,
        parsed.error
      );
    }
    validated = parsed.data;
  }

  const ctx: ToolContext = {
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    toolCallId: opts.toolCallId,
    sandboxRoots: opts.sandboxRoots,
    backends: opts.backends,
    fileObservations: opts.fileObservations,
    defaultCwd: opts.defaultCwd,
    signal: opts.signal,
    reportProgress: opts.onProgress,
    log: opts.log,
    gate: opts.gate
  };

  // A `needsApproval` predicate decides per-input; otherwise `highRisk` is the static default. A
  // PreToolUse hook's `ask` forces approval on top of either (hook policy and the tool's own gating
  // are additive).
  const mustApprove =
    opts.forceApproval === true ||
    (tool.needsApproval ? await tool.needsApproval(validated, ctx) : tool.highRisk === true);
  if (mustApprove) {
    if (!opts.gate) {
      throw new ToolGateDeniedError(`tool "${tool.name}" requires an approval gate but none is configured`);
    }
    const outcome = await opts.gate({
      tool: tool.name,
      sessionId: opts.sessionId,
      highRisk: tool.highRisk === true,
      input: validated,
      key: tool.gateKey?.(validated)
    });
    if (!outcome.allow) {
      throw new ToolGateDeniedError(`tool "${tool.name}" denied by gate: ${outcome.reason}`);
    }
  }

  const result = await tool.run(validated, ctx);
  const parsedResult = toolResultSchema.safeParse(result);
  if (!parsedResult.success) {
    throw new ToolResultError(
      `invalid result from tool "${tool.name}": ${describeSchemaError(parsedResult.error)}`,
      parsedResult.error
    );
  }
  return parsedResult.data as ToolResult<Metadata>;
}

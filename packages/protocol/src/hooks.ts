// Lifecycle hook contract — the narrow, serializable port the agent loop and daemon call at
// fixed junctures (session/turn/model/tool/compact/subagent). Two implementations live behind
// `Hooks`: in-process typed atom-pack hooks and out-of-process command hooks (shell, JSON over
// stdin/stdout). The contract is value-based (not a mutable ctx + next()) precisely because a
// command hook may be a subprocess in another language — nothing crosses that boundary except
// serializable JSON.
//
// Naming: flat `<Before|After><Subject>` PascalCase with a self-evident subject (Turn / Model /
// Tool / Compact / Subagent), plus `SessionStart`/`SessionEnd` lifecycle facts and `ApprovalRequest`
// for the human approval gate. `AfterTool`/`AfterSubagent`/`AfterTurn` fire on BOTH success and
// failure — the failure is carried in the input (`ok`/`error`), and the handler decides. `AfterModel`
// fires only after a SUCCESSFUL response; a failed model call ends the turn via `AfterTurn(error)`.

import { z } from 'zod';

export const HOOK_EVENTS = [
  'SessionStart', // session created
  'BeforeTurn', // turn begins (user prompt submitted)
  'BeforeModel', // before each reasoning LLM request (main + subagent loops)
  'BeforeTool', // before a tool runs
  'ApprovalRequest', // a tool call hits the human approval gate
  'AfterTool', // after a tool runs (success or failure)
  'AfterModel', // after a successful reasoning LLM response
  'BeforeCompact', // before history compaction
  'AfterCompact', // after history compaction
  'BeforeSubagent', // before a forked subagent runs
  'AfterSubagent', // after a forked subagent finishes (success or failure)
  'AfterTurn', // a turn ends (completed / aborted / error)
  'SessionEnd' // session deleted
] as const;

export const hookEventSchema = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof hookEventSchema>;

/** Events that only observe or inject context — they cannot deny the step or chain a mutation into
 * the next hook, so the runner fans them out concurrently. Everything else runs serially because
 * each hook must see the previous one's rewrite (prompt / model / tool-io / text). A NEW event
 * defaults to serial (safe) unless added here. */
export const PARALLEL_HOOK_EVENTS = new Set<HookEvent>(['SessionStart', 'BeforeCompact', 'AfterCompact', 'SessionEnd']);

/** Identifies which reasoning loop is calling the model — so a `BeforeModel`/`AfterModel` hook can
 *  scope itself to the main turn vs a forked subagent (named via `agentName` when known). (Infra/
 *  utility model calls — summarization, embeddings, vision — do NOT fire these events; compaction
 *  has its own Before/AfterCompact.) */
export const hookCallerSchema = z.object({
  kind: z.enum(['main', 'subagent']),
  agentName: z.string().optional()
});
export type HookCaller = z.infer<typeof hookCallerSchema>;

/** Serializable envelope handed to every hook. Event-specific fields are populated per event. */
export const hookInputSchema = z.object({
  event: hookEventSchema,
  sessionId: z.string(),
  /** Resolved sandbox/workspace root — command hooks run with this cwd. */
  cwd: z.string(),
  timestamp: z.string(),
  prompt: z.string().optional(), // BeforeTurn
  toolName: z.string().optional(), // BeforeTool / AfterTool / ApprovalRequest
  toolInput: z.unknown().optional(), // BeforeTool / AfterTool / ApprovalRequest
  toolResult: z.string().optional(), // AfterTool (the observation fed back to the model)
  /** AfterTool / AfterSubagent / AfterTurn: did the underlying step succeed? On failure `error` carries
   *  the message, and the handler decides (e.g. retry, annotate, ignore). One event for success and
   *  failure — no split. (AfterModel does not use these — it fires only on a successful response.) */
  ok: z.boolean().optional(),
  error: z.string().optional(),
  reason: z.enum(['completed', 'aborted', 'error']).optional(), // AfterTurn / SessionEnd
  /** Turn usage/cost, attached for observation (e.g. push to a dashboard). AfterTurn only. */
  usage: z.unknown().optional(),
  cost: z.unknown().optional(),
  /** BeforeModel / AfterModel: which loop is calling, and the request / response payload. */
  caller: hookCallerSchema.optional(),
  request: z.unknown().optional(), // BeforeModel: { model, messages } — a hook may rewrite it
  response: z.string().optional(), // AfterModel: the response text — a hook may rewrite via mutatedText
  /** Before/AfterCompact: whether compaction was triggered automatically (`soft`, over the threshold)
   *  or by an explicit `/compact` (`manual`), and the token size of the window being compacted. A
   *  BeforeCompact hook may return `additionalContext` to fold preserve-this instructions into the
   *  summarization prompt. */
  compaction: z.object({ trigger: z.enum(['soft', 'manual']), tokens: z.number() }).optional(),
  /** Before/AfterSubagent: the forked skill/subagent name and (AfterSubagent) its result text, which
   *  a hook may rewrite via `mutatedText` (e.g. redact/annotate before it surfaces to the parent). */
  subagentName: z.string().optional(),
  subagentResult: z.string().optional()
});
export type HookInput = z.infer<typeof hookInputSchema>;

/**
 * What one hook returns. Fields not relevant to the firing event are ignored. `decision`:
 * `deny` truncates the lifecycle step; `ask` (BeforeTool) routes the call to the human approval
 * gate; `allow`/absent proceeds. `mutatedText` rewrites an AfterModel response, an AfterSubagent
 * result, or an AfterTurn final text; `additionalContext` on BeforeCompact folds preserve-this
 * instructions into the summarization prompt.
 */
export const hookOutputSchema = z.object({
  decision: z.enum(['allow', 'deny', 'ask']).optional(),
  reason: z.string().optional(),
  additionalContext: z.string().optional(),
  mutatedPrompt: z.string().optional(), // BeforeTurn
  modelOverride: z.string().optional(), // BeforeTurn
  mutatedToolInput: z.unknown().optional(), // BeforeTool
  updatedToolOutput: z.string().optional(), // AfterTool
  mutatedRequest: z.unknown().optional(), // BeforeModel: rewrite the model request's messages
  mutatedText: z.string().optional(), // AfterModel / AfterSubagent / AfterTurn
  continueWork: z.object({ reason: z.string() }).optional() // AfterTurn
});
export type HookOutput = z.infer<typeof hookOutputSchema>;

/** The runner's aggregate of all matching hooks for one event, handed back to the caller. */
export interface HookDecision {
  blocked: boolean; // any hook denied
  ask: boolean; // any hook asked (BeforeTool → gate)
  allowed: boolean; // a hook explicitly returned `allow` (ApprovalRequest → auto-approve)
  reason?: string;
  additionalContext: string[];
  effectivePrompt?: string;
  modelOverride?: string;
  effectiveToolInput?: unknown;
  effectiveToolOutput?: string;
  effectiveRequest?: unknown; // BeforeModel rewrite
  effectiveText?: string;
  continueWork?: { reason: string };
}

/** The narrow port agent-core depends on; the daemon injects the concrete runner. */
export interface Hooks {
  run(input: HookInput): Promise<HookDecision>;
}

/** No-op hooks — keeps call sites unconditional when no hooks are configured. */
export const NO_HOOKS: Hooks = {
  run: async (input) => ({
    blocked: false,
    ask: false,
    allowed: false,
    additionalContext: [],
    effectivePrompt: input.prompt,
    effectiveToolInput: input.toolInput,
    effectiveToolOutput: input.toolResult,
    effectiveRequest: input.request
  })
};

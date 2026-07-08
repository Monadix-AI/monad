import type { EventType, Hooks, SessionId } from '@monad/protocol';
import type { Tool, ToolGate, ToolModelContent, ToolResult, ToolResultPart } from '#/capabilities/tools/types.ts';
import type { ModelContentPart, ModelMessage, ToolCall } from '../../model/index.ts';
import type { PersistedToolCall, PersistedToolResult, PersistedToolResultEnvelope } from '../replay.ts';
import type { AgentLoopDeps } from '../types.ts';

import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { invokeTool } from '#/capabilities/tools/invoke.ts';
import { shouldStripAnsiForTool, stripAnsiFromToolOutput } from '../ansi-output.ts';
import { persistToolResultEnvelope } from '../replay.ts';
import { DEFAULT_MAX_TOOL_RESULT_CHARS, logInput, truncateToolOutput } from '../tool-output.ts';

// Minimum gap between streamed tool.progress events for one tool call (drops intermediate chunks).
const PROGRESS_THROTTLE_MS = 100;

const log = createLogger('tool-trace');

function modelContentText(content: ToolModelContent, toolName: string, strip = false): string {
  if (typeof content === 'string') return strip ? stripAnsiFromToolOutput(toolName, content) : content;
  return content
    .filter((p): p is Extract<ToolResultPart, { type: 'text' }> => p.type === 'text')
    .map((p) => (strip ? stripAnsiFromToolOutput(toolName, p.text) : p.text))
    .join('\n');
}

type ExecuteOutcome = {
  observation: string;
  displayObservation?: string;
  display?: unknown;
  result?: PersistedToolResultEnvelope;
  rawResult?: PersistedToolResultEnvelope;
  mediaParts?: ModelContentPart[];
  ok: boolean;
};

/**
 * Executes and persists one model step's tool calls: gate/hook orchestration around invokeTool,
 * result truncation, and the assistant/tool message pair each call contributes to the next
 * prompt. Split out of AgentLoop because it's the self-contained "run this tool call" concern,
 * distinct from prompt assembly and turn lifecycle.
 */
export class ToolExecutor {
  constructor(
    private readonly deps: AgentLoopDeps,
    private readonly availableTools: () => Tool[],
    private readonly hooks: () => Hooks,
    private readonly hookCwd: () => string,
    private readonly effectiveGate: () => ToolGate | undefined,
    private readonly emitEvent: (sessionId: SessionId, type: EventType, payload: object) => void,
    private readonly pushInjectedContext: (context: string[]) => void,
    private readonly activateSkill: (name: string) => void
  ) {}

  /**
   * Execute every tool-call from one model step, then append the structured assistant
   * (text + tool-call parts) and tool (tool-result parts) messages to `messages` so the next
   * step sees them. Multimodal tool output (e.g. an image) rides on a follow-up user message,
   * since tool-results carry text at the provider boundary.
   */
  async runToolCalls(
    sessionId: SessionId,
    assistantText: string,
    calls: ToolCall[],
    messages: ModelMessage[],
    signal?: AbortSignal
  ): Promise<void> {
    const callParts: ModelContentPart[] = calls.map((c) => ({
      type: 'tool-call',
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input
    }));
    messages.push({
      role: 'assistant',
      content: assistantText ? [{ type: 'text', text: assistantText }, ...callParts] : callParts
    });

    // Execute the step's calls concurrently (providers can request several at once), then
    // assemble results in call order so the tool-result parts line up with their tool-calls.
    const outcomes = await Promise.all(calls.map((call) => this.executeToolCall(sessionId, call, signal)));

    const resultParts: ModelContentPart[] = [];
    const followups: ModelMessage[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i] as ToolCall;
      const {
        observation,
        displayObservation,
        display,
        result,
        rawResult,
        mediaParts,
        ok: stepOk = false
      } = outcomes[i] as ExecuteOutcome;
      resultParts.push({
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: observation
      });
      await this.persistToolStep(
        sessionId,
        call,
        observation,
        false,
        stepOk,
        displayObservation,
        display,
        result,
        rawResult
      );
      if (mediaParts?.length) followups.push({ role: 'user', content: mediaParts });
    }
    messages.push({ role: 'tool', content: resultParts });
    messages.push(...followups);
  }

  private async executeToolCall(sessionId: SessionId, call: ToolCall, signal?: AbortSignal): Promise<ExecuteOutcome> {
    this.emitEvent(sessionId, 'tool.called', { toolCallId: call.toolCallId, tool: call.toolName, input: call.input });
    log.debug({ toolCallId: call.toolCallId, sessionId, input: logInput(call.input) }, `→ ${call.toolName}`);
    const tool = this.availableTools().find((t) => t.name === call.toolName);
    if (!tool) {
      const msg = `unknown tool "${call.toolName}"`;
      this.emitEvent(sessionId, 'tool.result', {
        toolCallId: call.toolCallId,
        tool: call.toolName,
        ok: false,
        result: msg
      });
      return { observation: `Error: ${msg}`, ok: false };
    }

    // PreToolUse: a hook may deny (skip the tool, feed the reason back as an error), rewrite the
    // input, or `ask` (force this call through the approval gate even if the tool isn't high-risk).
    const pre = await this.hooks().run({
      event: 'BeforeTool',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      toolName: call.toolName,
      toolInput: call.input
    });
    if (pre.blocked) {
      const denied = pre.reason ?? 'blocked by hook';
      // `deniedBy: 'hook'` lets clients render a policy block distinctly from a tool failure.
      this.emitEvent(sessionId, 'tool.result', {
        toolCallId: call.toolCallId,
        tool: call.toolName,
        ok: false,
        result: denied,
        deniedBy: 'hook'
      });
      return { observation: `Error: ${denied}`, ok: false };
    }
    if (pre.additionalContext.length) this.pushInjectedContext(pre.additionalContext);
    const toolInput = pre.effectiveToolInput ?? call.input;

    let ok = true;
    let resultText: string;
    let displayResultText: string | undefined;
    let display: unknown;
    let parts: ToolResultPart[] | undefined;
    let rawResult: ToolResult<unknown> | undefined;
    const t0 = Date.now();
    // Throttle live progress: a chatty command emits output in many small chunks, and each
    // tool.progress carries the FULL cumulative output — unthrottled that's O(n²) data and a
    // notification flood. Drop intermediates; the final tool.result always carries complete output.
    let lastProgressAt = 0;
    try {
      const output = await invokeTool(tool, toolInput, {
        sessionId,
        toolCallId: call.toolCallId,
        sandboxRoots: this.deps.sandboxRoots,
        backends: this.deps.backends,
        fileObservations: this.deps.fileObservations,
        defaultCwd: this.deps.defaultCwd,
        signal,
        forceApproval: pre.ask,
        onProgress: (output) => {
          const now = Date.now();
          if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
          lastProgressAt = now;
          this.emitEvent(sessionId, 'tool.progress', { toolCallId: call.toolCallId, tool: call.toolName, output });
        },
        log: () => {},
        gate: this.effectiveGate()
      });
      rawResult = output;
      displayResultText = shouldStripAnsiForTool(call.toolName)
        ? modelContentText(output.modelContent, call.toolName)
        : undefined;
      resultText = modelContentText(output.modelContent, call.toolName, true);
      parts = Array.isArray(output.modelContent) ? output.modelContent : undefined;
      display = output.displayContent;
    } catch (err) {
      ok = false;
      resultText = err instanceof Error ? err.message : String(err);
    }
    // Cap the result before it's fed back / persisted, so one huge output can't blow the window.
    resultText = truncateToolOutput(resultText, this.deps.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS);
    if (displayResultText !== undefined) {
      displayResultText = truncateToolOutput(
        displayResultText,
        this.deps.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS
      );
      if (displayResultText === resultText) displayResultText = undefined;
    }
    // AfterTool: a hook may rewrite the result fed back to the model (e.g. redact secrets) or append
    // context. Fires on success AND failure — `ok`/`error` carry the outcome, the handler decides.
    const post = await this.hooks().run({
      event: 'AfterTool',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      toolName: call.toolName,
      toolInput,
      toolResult: resultText,
      ok,
      ...(ok ? {} : { error: resultText })
    });
    const beforePost = resultText;
    if (post.effectiveToolOutput !== undefined) resultText = post.effectiveToolOutput;
    if (post.additionalContext.length) resultText = `${resultText}\n\n${post.additionalContext.join('\n\n')}`;
    const hookModified = resultText !== beforePost;
    if (hookModified) {
      displayResultText = undefined;
      display = undefined;
      parts = undefined;
    }
    const observation = ok ? resultText : `Error: ${resultText}`;
    const persistedResult: PersistedToolResultEnvelope = rawResult
      ? persistToolResultEnvelope({
          modelContent: observation,
          metadata: hookModified ? null : rawResult.metadata,
          ...(display !== undefined ? { displayContent: display as ToolResult<unknown>['displayContent'] } : {})
        })
      : { modelContent: observation, metadata: { error: resultText } };
    const persistedRawResult = undefined;
    // Loading a skill via the `skill` tool activates its allowed-tools grants for later steps.
    if (ok && tool.name === 'skill') {
      const loaded = (call.input as { name?: unknown } | null)?.name;
      if (typeof loaded === 'string') this.activateSkill(loaded);
    }
    this.emitEvent(sessionId, 'tool.result', {
      toolCallId: call.toolCallId,
      tool: call.toolName,
      ok,
      result: resultText,
      ...(displayResultText ? { displayResult: displayResultText } : {}),
      ...(display !== undefined ? { display } : {}),
      ...(hookModified ? { hookModified: true } : {})
    });
    const durationMs = Date.now() - t0;
    if (ok) {
      log.debug({ toolCallId: call.toolCallId, sessionId, durationMs, chars: resultText.length }, `← ${call.toolName}`);
    } else {
      log.warn(
        { toolCallId: call.toolCallId, sessionId, durationMs, err: resultText.slice(0, 300) },
        `← ${call.toolName} failed`
      );
    }

    const mediaParts = parts
      ?.filter((p): p is Extract<ToolResultPart, { type: 'image' }> => p.type === 'image')
      .map((p) => ({ type: 'image' as const, image: p.image, ...(p.mediaType ? { mediaType: p.mediaType } : {}) }));
    const displayObservation =
      displayResultText === undefined ? undefined : ok ? displayResultText : `Error: ${displayResultText}`;
    return {
      observation,
      displayObservation,
      display: persistedResult.displayContent,
      result: persistedResult,
      rawResult: persistedRawResult,
      mediaParts: mediaParts?.length ? mediaParts : undefined,
      ok
    };
  }

  /**
   * Persist one tool round-trip so the NEXT turn's prompt (and the UI history) include it.
   * For client-executed calls the rows are replayed as native function-calling on a later turn.
   * Provider-executed calls (e.g. Anthropic/OpenAI native web_search) are flagged so replayHistory
   * degrades them to text observations instead — providers reject stale tool_use IDs.
   */
  async persistToolStep(
    sessionId: SessionId,
    call: ToolCall,
    observation: string,
    providerExecuted = false,
    ok = true,
    displayObservation?: string,
    display?: unknown,
    result?: PersistedToolResultEnvelope,
    rawResult?: PersistedToolResultEnvelope
  ): Promise<void> {
    const callData: PersistedToolCall = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      ...(providerExecuted ? { providerExecuted: true } : {})
    };
    const resultData: PersistedToolResult = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      result: result ?? { modelContent: observation, metadata: null },
      ...(rawResult ? { rawResult } : {}),
      output: displayObservation ?? observation,
      ...(display !== undefined ? { display } : {}),
      ok
    };
    await this.deps.messages.append({
      id: newId('msg'),
      sessionId,
      role: 'assistant',
      text: JSON.stringify({ tool: call.toolName, input: call.input }),
      createdAt: new Date().toISOString(),
      type: 'tool_call',
      data: callData
    });
    await this.deps.messages.append({
      id: newId('msg'),
      sessionId,
      role: 'tool',
      text: observation,
      createdAt: new Date().toISOString(),
      type: 'tool_result',
      data: resultData
    });
  }
}

import type { AgentMessagePayload, AgentReasoningPayload, EventType, Hooks, SessionId } from '@monad/protocol';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { PersistedModelInputOverride } from '../replay.ts';
import type { AgentLoopDeps, ChatMessage } from '../types.ts';
import type { PromptBuilder } from './prompt-builder.ts';

import { newId } from '@monad/protocol';

import { PROVIDER_CONFIG_ERROR_CODE } from '../../model/gateway/gateway-routing.ts';
import { extractError } from '../extract-error.ts';

/**
 * Turn output persistence and bookkeeping: user/assistant rows, lazily-opened streaming text
 * segments, per-turn usage/cost accounting, reasoning deltas, and error rows. Split out of
 * AgentLoop because it's the self-contained "write what the turn produced" concern, distinct
 * from prompt assembly and the tool round-trip loop.
 */
export class TurnWriter {
  constructor(
    private readonly deps: AgentLoopDeps,
    private readonly emitEvent: (sessionId: SessionId, type: EventType, payload: object) => void,
    private readonly prompt: () => PromptBuilder,
    private readonly availableTools: () => Tool[],
    private readonly modelId: () => string,
    private readonly turnInjectedContext: () => string[],
    private readonly hooks: () => Hooks,
    private readonly hookCwd: () => string
  ) {}

  /** Persist an empty assistant row so a turn that ended with no closing text still has an answer
   * message (the UI anchors the turn on it). Excluded from context — an empty assistant turn must
   * not reach the next prompt (some providers reject empty assistant content). */
  async appendEmptyAnswer(sessionId: SessionId, messageId: `msg_${string}`): Promise<void> {
    await this.deps.messages.append({
      id: messageId,
      sessionId,
      role: 'assistant',
      text: '',
      includeInContext: false,
      createdAt: new Date().toISOString()
    });
  }

  async beginTurn(
    sessionId: SessionId,
    userText: string,
    modelInput?: PersistedModelInputOverride
  ): Promise<`msg_${string}`> {
    const userMessageId = newId('msg');
    await this.deps.messages.append({
      id: userMessageId,
      sessionId,
      role: 'user',
      text: userText,
      data: modelInput,
      createdAt: new Date().toISOString()
    });
    // Push the accepted user turn so clients that didn't originate it (other tabs, a Telegram-
    // started turn) render the bubble now instead of waiting for the end-of-turn history refetch.
    this.emitEvent(sessionId, 'user.message', { messageId: userMessageId, text: userText });
    // The assistant row(s) are NOT opened here. Each assistant text segment is created lazily at its
    // FIRST token (see beginSegment) so it sorts after any tool rows that ran before it. We return
    // the id the first segment will use; a turn with no leading text just never opens it.
    return newId('msg');
  }

  /**
   * One assistant text segment: the row is opened (pending→streaming) lazily on the first token, so
   * a turn's `text → tool → text` sequence persists as ordered rows instead of one flattened row.
   * `settle(text)` writes the final content in place (append-fallback for non-streaming repos); it
   * returns false when the segment produced no text, so the caller can skip an empty row.
   */
  beginSegment(sessionId: SessionId, segmentId: `msg_${string}`, reasonBase: number) {
    let opened = false;
    let tokenIndex = 0;
    let reasonIndex = reasonBase;
    return {
      emitToken: (delta: string): void => {
        if (!opened) {
          opened = true;
          // Synchronous for the store-backed repo (bun:sqlite); a no-op for the in-memory repo.
          void this.deps.messages.open?.({
            id: segmentId,
            sessionId,
            role: 'assistant',
            text: '',
            createdAt: new Date().toISOString()
          });
          void this.deps.messages.markStreaming?.(sessionId, segmentId);
        }
        this.emitEvent(sessionId, 'agent.token', { messageId: segmentId, delta, index: tokenIndex++ });
      },
      emitReasoning: (delta: string): void => this.emitReasoning(sessionId, segmentId, delta, reasonIndex++),
      reasonIndex: (): number => reasonIndex,
      settle: async (text: string, reasoning?: string): Promise<boolean> => {
        if (!opened && text === '') return false;
        const message: ChatMessage = {
          id: segmentId,
          sessionId,
          role: 'assistant',
          text,
          createdAt: new Date().toISOString(),
          ...(reasoning ? { data: { reasoning } } : {})
        };
        const settled = this.deps.messages.settle ? await this.deps.messages.settle(message, 'complete') : false;
        if (!settled) await this.deps.messages.append(message);
        return true;
      }
    };
  }

  async finishTurn(
    sessionId: SessionId,
    messageId: `msg_${string}`,
    text: string,
    usage?: AgentMessagePayload['usage'],
    finishReason?: AgentMessagePayload['finishReason'],
    reasoning?: string
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      createdAt: new Date().toISOString(),
      // Persist the extended-thinking trace alongside the answer so the UI can show it from
      // history (the live `agent.reasoning` deltas are transient). Carried in `data`, which
      // replayHistory ignores for prose turns — so it never costs prompt tokens on later turns.
      ...(reasoning ? { data: { reasoning } } : {})
    };
    // Non-streaming (block) turns have no open segment row, so settle finds nothing and we append —
    // landing the assistant row after the turn's tool rows (correct order).
    const settled = this.deps.messages.settle ? await this.deps.messages.settle(message, 'complete') : false;
    if (!settled) await this.deps.messages.append(message);
    await this.finishBookkeeping(sessionId, messageId, text, usage, finishReason);
    return message;
  }

  /** Per-turn accounting + events, emitted once after the final assistant content is persisted:
   * record real usage/cost, self-calibrate the token estimator, emit `agent.message` and the
   * `context.usage` breakdown. The assistant row itself is written by the segment/finishTurn path. */
  async finishBookkeeping(
    sessionId: SessionId,
    messageId: `msg_${string}`,
    text: string,
    usage?: AgentMessagePayload['usage'],
    finishReason?: AgentMessagePayload['finishReason']
  ): Promise<void> {
    const cost = usage ? this.deps.recordTurnUsage?.(sessionId, usage, this.modelId()) : undefined;
    this.prompt().observeEstimator(usage);
    const payload: AgentMessagePayload = { messageId, text, usage, ...(cost ? { cost } : {}), finishReason };
    this.emitEvent(sessionId, 'agent.message', payload);
    await this.prompt().emitContextUsage(
      sessionId,
      this.availableTools().length > 0,
      usage?.inputTokens,
      this.turnInjectedContext()
    );
  }

  /** Best-effort re-persist of a settled segment when a Stop hook rewrote the final text (the
   * streamed row was already settled with the original). No-op for repos without `settle`. */
  async repersistFinalText(sessionId: SessionId, messageId: `msg_${string}`, text: string): Promise<void> {
    await this.deps.messages.settle?.(
      { id: messageId, sessionId, role: 'assistant', text, createdAt: new Date().toISOString() },
      'complete'
    );
  }

  /** Emit one reasoning/extended-thinking delta on its own channel (transient, not persisted). */
  emitReasoning(sessionId: SessionId, messageId: `msg_${string}`, delta: string, index: number): void {
    const payload: AgentReasoningPayload = { messageId, delta, index };
    this.emitEvent(sessionId, 'agent.reasoning', payload);
  }

  async emitError(sessionId: SessionId, messageId: string, err: unknown): Promise<void> {
    const { code, message, providerId } = extractError(err);
    const text = code ? `[${code}] ${message}` : message;
    // Provider-config failures (missing credentials, unsupported capability) get their own message
    // type + `providerId` so the UI can render a "fix provider settings" card instead of a raw error.
    const isProviderConfig = code === PROVIDER_CONFIG_ERROR_CODE;
    // Persist the failure as an assistant message so it survives in history and is visible even when
    // the live event stream can't deliver. Tagged `error`/`provider_config_error` so buildPrompt
    // never replays it back to the model. Settle the row opened in beginTurn (→ error); repos
    // without the lifecycle append it.
    const errMessage: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      createdAt: new Date().toISOString(),
      type: isProviderConfig ? 'provider_config_error' : 'error',
      ...(isProviderConfig ? { data: { providerId } } : {})
    };
    try {
      const settled = this.deps.messages.settle ? await this.deps.messages.settle(errMessage, 'error') : false;
      if (!settled) await this.deps.messages.append(errMessage);
    } catch (appendErr) {
      // A turn can fail after the assistant row is already persisted (e.g. post-persist side
      // effects). Re-using the same messageId must not crash the daemon on a duplicate insert.
      if (!String(appendErr).includes('UNIQUE constraint failed: messages.id')) throw appendErr;
    }
    this.emitEvent(sessionId, 'agent.error', {
      messageId,
      code,
      message,
      ...(isProviderConfig ? { providerId } : {})
    });
    // AfterTurn also fires when a turn ends in failure (the success path fires it via runStopHook).
    // Observe-only here — the turn already errored; a hook can log/notify but not rewrite the answer.
    await this.hooks().run({
      event: 'AfterTurn',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      reason: 'error',
      ok: false,
      error: text
    });
  }
}

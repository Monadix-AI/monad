import type { EventType, FinishReason, Hooks, SessionId, TokenUsage } from '@monad/protocol';
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
  private readonly openedAt = new Map<string, string>();
  private readonly fallbackRevisions = new Map<SessionId, number>();

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

  private publishOptions() {
    return this.deps.messageFanout ? { fanout: this.deps.messageFanout } : undefined;
  }

  private nextFallbackRevision(sessionId: SessionId): number {
    const revision = (this.fallbackRevisions.get(sessionId) ?? 0) + 1;
    this.fallbackRevisions.set(sessionId, revision);
    return revision;
  }

  private canonicalSnapshot(message: ChatMessage, status: 'pending' | 'settled' | 'complete' | 'error') {
    return {
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      text: message.text,
      type: message.type ?? 'text',
      ...(message.data === undefined ? {} : { data: message.data }),
      stream:
        status === 'pending'
          ? { status, source: { transcriptTargetId: message.sessionId, messageId: message.id } }
          : { status },
      active: true,
      ...(message.includeInContext === undefined ? {} : { includeInContext: message.includeInContext }),
      createdAt: message.createdAt
    };
  }

  private emitFallbackLifecycle(
    sessionId: SessionId,
    type: 'session.message.created' | 'session.message.completed' | 'session.message.failed',
    message: ChatMessage,
    status: 'pending' | 'settled' | 'complete' | 'error'
  ): void {
    if (this.deps.messages.publishesCanonicalEvents) return;
    this.emitEvent(sessionId, type, {
      transcriptTargetId: sessionId,
      producer: { kind: 'system', subsystem: 'agent-loop' },
      message: this.canonicalSnapshot(message, status),
      messageRevision: this.nextFallbackRevision(sessionId)
    });
  }

  private async ensureAssistantOpen(sessionId: SessionId, messageId: `msg_${string}`): Promise<string> {
    const existing = this.openedAt.get(messageId);
    if (existing) return existing;
    const createdAt = new Date().toISOString();
    this.openedAt.set(messageId, createdAt);
    const message: ChatMessage = { id: messageId, sessionId, role: 'assistant', text: '', createdAt };
    await this.deps.messages.open?.(message, this.publishOptions());
    this.emitFallbackLifecycle(sessionId, 'session.message.created', message, 'pending');
    return createdAt;
  }

  /** Persist an empty assistant row so a turn that ended with no closing text still has an answer
   * message (the UI anchors the turn on it). Excluded from context — an empty assistant turn must
   * not reach the next prompt (some providers reject empty assistant content). */
  async appendEmptyAnswer(
    sessionId: SessionId,
    messageId: `msg_${string}`,
    data?: Record<string, unknown>
  ): Promise<void> {
    const createdAt = await this.ensureAssistantOpen(sessionId, messageId);
    const message: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      text: '',
      includeInContext: false,
      ...(data ? { data } : {}),
      createdAt
    };
    const settled = this.deps.messages.settle
      ? await this.deps.messages.settle(message, 'complete', this.publishOptions())
      : false;
    if (!settled) await this.deps.messages.append(message, this.publishOptions());
    this.emitFallbackLifecycle(sessionId, 'session.message.completed', message, 'complete');
  }

  async beginTurn(
    sessionId: SessionId,
    userText: string,
    modelInput?: PersistedModelInputOverride
  ): Promise<`msg_${string}`> {
    const userMessageId = newId('msg');
    const userMessage: ChatMessage = {
      id: userMessageId,
      sessionId,
      role: 'user',
      text: userText,
      data: modelInput,
      createdAt: new Date().toISOString()
    };
    await this.deps.messages.append(userMessage, this.publishOptions());
    this.emitFallbackLifecycle(sessionId, 'session.message.created', userMessage, 'settled');
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
    let emitted = false;
    let openPromise: Promise<void> | undefined;
    let ingressQueue = Promise.resolve();
    let tokenIndex = 0;
    let reasonIndex = reasonBase;
    const ensureOpen = () => {
      if (opened) return openPromise ?? Promise.resolve();
      opened = true;
      openPromise = this.ensureAssistantOpen(sessionId, segmentId).then(() => {});
      void this.deps.messages.markStreaming?.(sessionId, segmentId);
      return openPromise;
    };
    const appendDelta = (channel: string, index: number, delta: string) => {
      emitted = true;
      ingressQueue = ingressQueue.then(async () => {
        await ensureOpen();
        if (this.deps.messages.appendDelta) {
          await this.deps.messages.appendDelta(
            { sessionId, messageId: segmentId, channel, index, delta },
            this.publishOptions()
          );
          return;
        }
        this.emitEvent(sessionId, 'session.message.delta.appended', {
          transcriptTargetId: sessionId,
          producer: { kind: 'system', subsystem: 'agent-loop' },
          messageId: segmentId,
          channel,
          index,
          delta
        });
      });
    };
    return {
      emitToken: (delta: string): void => {
        appendDelta('answer', tokenIndex++, delta);
      },
      emitReasoning: (delta: string): void => appendDelta('reasoning', reasonIndex++, delta),
      reasonIndex: (): number => reasonIndex,
      settle: async (text: string, reasoning?: string, terminalData?: Record<string, unknown>): Promise<boolean> => {
        if (!emitted && text === '') return false;
        await ensureOpen();
        await ingressQueue;
        const createdAt = this.openedAt.get(segmentId) ?? new Date().toISOString();
        const message: ChatMessage = {
          id: segmentId,
          sessionId,
          role: 'assistant',
          text,
          createdAt,
          ...(reasoning || terminalData ? { data: { ...(reasoning ? { reasoning } : {}), ...terminalData } } : {})
        };
        const settled = this.deps.messages.settle
          ? await this.deps.messages.settle(message, 'complete', this.publishOptions())
          : false;
        if (!settled) await this.deps.messages.append(message, this.publishOptions());
        this.emitFallbackLifecycle(sessionId, 'session.message.completed', message, 'complete');
        return true;
      }
    };
  }

  async finishTurn(
    sessionId: SessionId,
    messageId: `msg_${string}`,
    text: string,
    usage?: TokenUsage,
    finishReason?: FinishReason,
    reasoning?: string
  ): Promise<ChatMessage> {
    const data = this.terminalData(sessionId, usage, finishReason, reasoning);
    const createdAt = await this.ensureAssistantOpen(sessionId, messageId);
    const message: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      createdAt,
      // Persist the extended-thinking trace alongside the answer so the UI can show it from
      // history (live reasoning deltas are transient). Carried in `data`, which
      // replayHistory ignores for prose turns — so it never costs prompt tokens on later turns.
      ...(data ? { data } : {})
    };
    // Non-streaming (block) turns have no open segment row, so settle finds nothing and we append —
    // landing the assistant row after the turn's tool rows (correct order).
    const settled = this.deps.messages.settle
      ? await this.deps.messages.settle(message, 'complete', this.publishOptions())
      : false;
    if (!settled) await this.deps.messages.append(message, this.publishOptions());
    this.emitFallbackLifecycle(sessionId, 'session.message.completed', message, 'complete');
    await this.finishBookkeeping(sessionId, messageId, text, usage, finishReason);
    return message;
  }

  /** Emit the context-usage breakdown after the terminal assistant snapshot is persisted. */
  async finishBookkeeping(
    sessionId: SessionId,
    _messageId: `msg_${string}`,
    _text: string,
    usage?: TokenUsage,
    _finishReason?: FinishReason
  ): Promise<void> {
    await this.prompt().emitContextUsage(
      sessionId,
      this.availableTools().length > 0,
      usage?.inputTokens,
      this.turnInjectedContext()
    );
  }

  terminalData(
    sessionId: SessionId,
    usage?: TokenUsage,
    finishReason?: FinishReason,
    reasoning?: string
  ): Record<string, unknown> | undefined {
    const cost = usage ? this.deps.recordTurnUsage?.(sessionId, usage, this.modelId()) : undefined;
    this.prompt().observeEstimator(usage);
    const data = {
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
      ...(cost ? { cost } : {}),
      ...(finishReason ? { finishReason } : {})
    };
    return Object.keys(data).length > 0 ? data : undefined;
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
    const createdAt = await this.ensureAssistantOpen(sessionId, messageId as `msg_${string}`);
    const errMessage: ChatMessage = {
      id: messageId,
      sessionId,
      role: 'assistant',
      text,
      createdAt,
      type: isProviderConfig ? 'provider_config_error' : 'error',
      ...(isProviderConfig ? { data: { providerId } } : code ? { data: { code } } : {})
    };
    try {
      const settled = this.deps.messages.settle
        ? await this.deps.messages.settle(errMessage, 'error', this.publishOptions())
        : false;
      if (!settled) await this.deps.messages.append(errMessage, this.publishOptions());
      this.emitFallbackLifecycle(sessionId, 'session.message.failed', errMessage, 'error');
    } catch (appendErr) {
      // A turn can fail after the assistant row is already persisted (e.g. post-persist side
      // effects). Re-using the same messageId must not crash the daemon on a duplicate insert.
      if (!String(appendErr).includes('UNIQUE constraint failed: messages.id')) throw appendErr;
    }
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

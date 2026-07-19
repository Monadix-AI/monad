import type { AcpAgentConfig } from '@monad/environment';
import type { MessageAttachment, Session, SessionId } from '@monad/protocol';
import type { BuildChannelContextInput } from '#/agent/prompts/channel.ts';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { composeAcpChannelPrompt } from '#/agent/prompts/channel.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { channelDelegateMcpServers } from '#/handlers/session/handlers/messaging-members.ts';
import { acpAuthGuidance, directDelegate } from '#/services/delegation/acp-delegate.ts';
import { makeEvent } from '#/services/event-bus.ts';

type SandboxRootsFor = (
  sessionId: SessionId,
  cwd: string | undefined,
  rt: { sandboxRoots?: string[] } | undefined,
  override?: string[]
) => string[] | undefined;

// Access control reads the write policy STORED on the session (origin.writableBy) — mirrors the
// check in messaging.ts (kept local so this module has no import-cycle back to it).
function assertWriteAllowed(session: Session, transport: 'http'): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

/** Send text directly to a configured ACP agent, bypassing the monad LLM/routing layer entirely. */
export function createForwardAcpHandler(ctx: SessionContext, sandboxRootsFor: SandboxRootsFor) {
  const {
    deps: { log },
    aborts,
    runtime,
    beginRun,
    trackRun,
    makeEmit,
    persistAndRetire,
    requireSession,
    messageIngress
  } = ctx;

  const runtimeForSession = (sessionId: SessionId) => runtime.get(sessionId);

  return async function forwardToAcp({
    sessionId,
    agentName,
    text,
    displayText,
    attachments,
    ambientContext,
    channelPromptInput,
    onComplete
  }: {
    sessionId: SessionId;
    agentName: string;
    text: string;
    displayText?: string;
    attachments?: MessageAttachment[];
    ambientContext?: string;
    channelPromptInput?: BuildChannelContextInput;
    onComplete?: (text: string) => void | Promise<void>;
  }) {
    const session = requireSession(sessionId);
    assertWriteAllowed(session, 'http');
    // Reject if a turn is already streaming for this session — same concurrency guard as `send`.
    if (aborts.has(sessionId)) throw new HandlerError('conflict', 'a turn is already in progress for this session');
    const cfg = ctx.deps.configManager?.get().cfg;
    if (!cfg) throw new HandlerError('internal', 'daemon config not configured');
    const spec = cfg.acpAgents.find((a: AcpAgentConfig) => a.name === agentName && a.enabled !== false);
    if (!spec) throw new HandlerError('invalid', `ACP agent "${agentName}" not found or disabled`);
    log?.debug({ sessionId, event: 'session.forward_acp.start', agentName, text, ambientContext }, 'forward acp start');

    const { round, signal } = beginRun(sessionId);
    const emit = makeEmit(round);
    await messageIngress.deliver({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: { kind: 'user' },
      role: 'user',
      type: 'text',
      text: displayText ?? text,
      ...(attachments?.length ? { data: { attachments } } : {})
    });
    const agentMessage = await messageIngress.begin({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: { kind: 'system', subsystem: 'acp' },
      role: 'assistant',
      type: 'text',
      text: '',
      data: { agentName: spec.name }
    });
    const agentMsgId = agentMessage.id;
    const acpToolCallId = newId('tc');
    let tokenIndex = 0;
    let acpActivityStarted = false;
    let acpProcessOutput = '';
    let acpResponseOutput = '';
    let ingressQueue = Promise.resolve();

    const emitAcpActivityStart = () => {
      if (acpActivityStarted) return;
      acpActivityStarted = true;
      emit(
        makeEvent(sessionId as SessionId, 'tool.called', {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          input: { agent: spec.name }
        })
      );
      emit(
        makeEvent(sessionId as SessionId, 'tool.progress', {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          output: 'waiting for response...'
        })
      );
    };
    const emitAcpActivityProgress = () => {
      const sections = [
        acpProcessOutput.trim(),
        acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
      ].filter(Boolean);
      emit(
        makeEvent(sessionId as SessionId, 'tool.progress', {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          output: sections.join('\n\n') || 'waiting for response...'
        })
      );
    };

    const rt = runtimeForSession(sessionId);
    emitAcpActivityStart();
    const run = directDelegate(spec, composeAcpChannelPrompt(text, channelPromptInput), {
      sessionId,
      signal,
      sandboxRoots: sandboxRootsFor(sessionId, requireSession(sessionId).cwd, rt),
      backends: rt?.backends,
      toolFilter: rt?.toolFilter,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      mcpServers: channelDelegateMcpServers(cfg?.mcpServers, rt?.mcpServers),
      onChunk: (delta) => {
        const index = tokenIndex++;
        ingressQueue = ingressQueue.then(() =>
          messageIngress.append({
            transcriptTargetId: sessionId,
            messageId: agentMsgId,
            producer: { kind: 'system', subsystem: 'acp' },
            channel: 'content',
            index,
            delta
          })
        );
        acpResponseOutput += delta;
        emitAcpActivityProgress();
      },
      onActivity: (output) => {
        acpProcessOutput = output;
        emitAcpActivityProgress();
      }
    })
      .then(async (fullText) => {
        log?.debug(
          { sessionId, event: 'session.forward_acp.complete', agentName: spec.name, fullText },
          'forward acp complete'
        );
        emit(
          makeEvent(sessionId as SessionId, 'tool.result', {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            ok: true,
            result: 'completed'
          })
        );
        await ingressQueue;
        await messageIngress.settle({
          transcriptTargetId: sessionId,
          messageId: agentMsgId,
          idempotencyKey: newId('idem'),
          producer: { kind: 'system', subsystem: 'acp' },
          text: fullText,
          data: { agentName: spec.name }
        });
        if (onComplete) {
          try {
            await onComplete(fullText);
          } catch (err) {
            process.stderr.write(`channel next dispatch error (${sessionId}): ${err}\n`);
          }
        }
        persistAndRetire(sessionId, round);
      })
      .catch(async (err: unknown) => {
        const { code, message } = extractError(err);
        log?.debug(
          { sessionId, event: 'session.forward_acp.error', agentName: spec.name, code, message },
          'forward acp error'
        );
        const hint = acpAuthGuidance(err, spec, ctx.deps.localeService?.t);
        const errorText = hint ? `${message}\n\n${hint}` : message;
        emit(
          makeEvent(sessionId as SessionId, 'tool.result', {
            toolCallId: acpToolCallId,
            tool: `acp:${spec.name}`,
            ok: false,
            result: errorText
          })
        );
        await ingressQueue;
        await messageIngress.fail({
          transcriptTargetId: sessionId,
          messageId: agentMsgId,
          idempotencyKey: newId('idem'),
          producer: { kind: 'system', subsystem: 'acp' },
          error: { code: code ?? 'acp_failed', message: code ? `[${code}] ${errorText}` : errorText },
          type: 'error',
          data: { agentName: spec.name }
        });
        try {
          persistAndRetire(sessionId, round);
        } catch (innerErr) {
          process.stderr.write(`forwardToAcp persistAndRetire error (${sessionId}): ${innerErr}\n`);
        }
      });

    trackRun(sessionId, signal, run);

    return { accepted: true as const };
  };
}

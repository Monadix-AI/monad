import type { AcpAgentConfig } from '@monad/home';
import type { Session, SessionId } from '@monad/protocol';
import type { BuildChannelContextInput } from '#/agent/prompts/channel.ts';
import type { SessionContext } from '#/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { composeAcpChannelPrompt } from '#/agent/prompts/channel.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import { channelDelegateMcpServers } from '#/handlers/session/handlers/messaging-members.ts';
import { acpAuthGuidance, directDelegate } from '#/services/delegation/acp-delegate.ts';

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

/** Send text directly to a configured ACP agent, bypassing the monad LLM/routing layer entirely.
 *  Emits user.message + streaming agent.token + final agent.message into the session event stream
 *  so the existing session subscriber sees the exchange without any monad turn overhead. */
export function createForwardAcpHandler(ctx: SessionContext, sandboxRootsFor: SandboxRootsFor) {
  const {
    deps: { store, log },
    aborts,
    runtime,
    beginRun,
    trackRun,
    makeEmit,
    persistAndRetire,
    requireSession
  } = ctx;

  const runtimeForSession = (sessionId: SessionId) => runtime.get(sessionId);

  return async function forwardToAcp({
    sessionId,
    agentName,
    text,
    displayText,
    ambientContext,
    channelPromptInput,
    onComplete
  }: {
    sessionId: SessionId;
    agentName: string;
    text: string;
    displayText?: string;
    ambientContext?: string;
    channelPromptInput?: BuildChannelContextInput;
    onComplete?: (text: string) => void | Promise<void>;
  }) {
    const session = requireSession(sessionId);
    assertWriteAllowed(session, 'http');
    // Reject if a turn is already streaming for this session — same concurrency guard as `send`.
    if (aborts.has(sessionId)) throw new HandlerError('conflict', 'a turn is already in progress for this session');
    const paths = ctx.deps.paths;
    if (!paths) throw new HandlerError('internal', 'daemon paths not configured');
    const cfg = await loadAll(paths.config, paths.profile);
    const spec = (cfg?.acpAgents ?? []).find((a: AcpAgentConfig) => a.name === agentName && a.enabled !== false);
    if (!spec) throw new HandlerError('invalid', `ACP agent "${agentName}" not found or disabled`);
    log?.debug({ sessionId, event: 'session.forward_acp.start', agentName, text, ambientContext }, 'forward acp start');

    const { round, signal } = beginRun(sessionId);
    const emit = makeEmit(round);
    const userMsgId = newId('msg');
    const agentMsgId = newId('msg');
    const acpToolCallId = newId('tc');
    let tokenIndex = 0;
    let acpActivityStarted = false;
    let acpProcessOutput = '';
    let acpResponseOutput = '';

    const emitAcpActivityStart = () => {
      if (acpActivityStarted) return;
      acpActivityStarted = true;
      emit({
        id: newId('evt'),
        sessionId: sessionId as SessionId,
        type: 'tool.called',
        actorAgentId: null,
        payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
        at: new Date().toISOString()
      });
      emit({
        id: newId('evt'),
        sessionId: sessionId as SessionId,
        type: 'tool.progress',
        actorAgentId: null,
        payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, output: 'waiting for response...' },
        at: new Date().toISOString()
      });
    };
    const emitAcpActivityProgress = () => {
      const sections = [
        acpProcessOutput.trim(),
        acpResponseOutput ? `response stream:\n${acpResponseOutput}` : ''
      ].filter(Boolean);
      emit({
        id: newId('evt'),
        sessionId: sessionId as SessionId,
        type: 'tool.progress',
        actorAgentId: null,
        payload: {
          toolCallId: acpToolCallId,
          tool: `acp:${spec.name}`,
          output: sections.join('\n\n') || 'waiting for response...'
        },
        at: new Date().toISOString()
      });
    };

    emit({
      id: newId('evt'),
      sessionId: sessionId as SessionId,
      type: 'user.message',
      actorAgentId: null,
      payload: { messageId: userMsgId, text: displayText ?? text },
      at: new Date().toISOString()
    });
    store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');

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
        emit({
          id: newId('evt'),
          sessionId: sessionId as SessionId,
          type: 'agent.token',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, delta, index: tokenIndex++ },
          at: new Date().toISOString()
        });
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
        emit({
          id: newId('evt'),
          sessionId: sessionId as SessionId,
          type: 'tool.result',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: true, result: 'completed' },
          at: new Date().toISOString()
        });
        store.insertMessage(agentMsgId, sessionId, fullText, new Date().toISOString(), 'assistant', {
          data: { agentName: spec.name }
        });
        emit({
          id: newId('evt'),
          sessionId: sessionId as SessionId,
          type: 'agent.message',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, text: fullText },
          at: new Date().toISOString()
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
      .catch((err: unknown) => {
        const { code, message } = extractError(err);
        log?.debug(
          { sessionId, event: 'session.forward_acp.error', agentName: spec.name, code, message },
          'forward acp error'
        );
        const hint = acpAuthGuidance(err, spec, ctx.deps.localeService?.t);
        const errorText = hint ? `${message}\n\n${hint}` : message;
        emit({
          id: newId('evt'),
          sessionId: sessionId as SessionId,
          type: 'tool.result',
          actorAgentId: null,
          payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, ok: false, result: errorText },
          at: new Date().toISOString()
        });
        store.insertMessage(
          agentMsgId,
          sessionId,
          code ? `[${code}] ${errorText}` : errorText,
          new Date().toISOString(),
          'assistant',
          {
            type: 'error',
            data: { agentName: spec.name }
          }
        );
        emit({
          id: newId('evt'),
          sessionId: sessionId as SessionId,
          type: 'agent.error',
          actorAgentId: null,
          payload: { messageId: agentMsgId, agentName: spec.name, code, message: errorText },
          at: new Date().toISOString()
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

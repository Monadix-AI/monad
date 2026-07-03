import type { AcpAgentConfig, NativeCliAgentConfig } from '@monad/home';
import type { Event, NativeCliSessionView, TranscriptTarget, TranscriptTargetId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { composeAcpChannelPrompt } from '@/agent/prompts/channel.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import {
  channelDelegateMcpServers,
  managedNativeCliProjectMembers,
  nativeCliProjectMemberDisplayNameForAgent,
  nativeCliProjectMemberSettings
} from '@/handlers/session/handlers/messaging-members.ts';
import { acpAuthGuidance, directDelegate } from '@/services/delegation/acp-delegate.ts';
import { managedProjectLaunchMode } from '@/services/native-cli/managed-project.ts';

type SandboxRootsFor = (
  sessionId: TranscriptTargetId,
  cwd: string | undefined,
  rt: { sandboxRoots?: string[] } | undefined,
  override?: string[]
) => string[] | undefined;

type StartManagedNativeCliRuntimeWithRecovery = (args: {
  session: TranscriptTarget;
  spec: NativeCliAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  launchMode: NativeCliAgentConfig['defaultLaunchMode'];
  providerSessionRef?: string;
  input: string;
}) => Promise<NativeCliSessionView>;

/** Direct-forward handlers that bypass the monad LLM/routing layer entirely: `forwardToAcp` and
 *  `forwardToNativeCli` send text straight to a named ACP or native-CLI agent, emitting the same
 *  user.message/agent.token/agent.message event shape a normal turn would. Extracted from
 *  messaging.ts because both are self-contained request handlers, not shared delivery plumbing. */
export function createForwardHandlers(
  ctx: SessionContext,
  sandboxRootsFor: SandboxRootsFor,
  startManagedNativeCliRuntimeWithRecovery: StartManagedNativeCliRuntimeWithRecovery
) {
  const {
    deps: { store, log },
    aborts,
    runtime,
    beginRun,
    makeEmit,
    persistAndRetire,
    requireTranscriptTarget
  } = ctx;

  const runtimeForTranscriptTarget = (sessionId: TranscriptTargetId) => runtime.get(sessionId);

  // Access control reads the write policy STORED on the session (origin.writableBy) — mirrors the
  // check in messaging.ts (kept local so this module has no import-cycle back to it).
  function assertWriteAllowed(session: TranscriptTarget, transport: 'http'): void {
    const writableBy = session.origin?.writableBy;
    if (!writableBy) return;
    if (!writableBy.includes(transport)) {
      throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
    }
  }

  /** Send text directly to a configured ACP agent, bypassing the monad LLM layer.
   *  Emits user.message + streaming agent.token + final agent.message into the session event stream
   *  so the existing session subscriber sees the exchange without any monad turn overhead. */
  async function forwardToAcp({
    sessionId,
    agentName,
    text,
    displayText,
    ambientContext,
    onComplete
  }: {
    sessionId: TranscriptTargetId;
    agentName: string;
    text: string;
    displayText?: string;
    ambientContext?: string;
    onComplete?: (text: string) => void | Promise<void>;
  }) {
    const session = requireTranscriptTarget(sessionId);
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
        transcriptTargetId: sessionId,
        type: 'tool.called',
        actorAgentId: null,
        payload: { toolCallId: acpToolCallId, tool: `acp:${spec.name}`, input: { agent: spec.name } },
        at: new Date().toISOString()
      });
      emit({
        id: newId('evt'),
        transcriptTargetId: sessionId,
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
        transcriptTargetId: sessionId,
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
      transcriptTargetId: sessionId,
      type: 'user.message',
      actorAgentId: null,
      payload: { messageId: userMsgId, text: displayText ?? text },
      at: new Date().toISOString()
    });
    store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');

    const rt = runtimeForTranscriptTarget(sessionId);
    emitAcpActivityStart();
    directDelegate(spec, composeAcpChannelPrompt(text, ambientContext), {
      sessionId,
      signal,
      sandboxRoots: sandboxRootsFor(sessionId, requireTranscriptTarget(sessionId).cwd, rt),
      backends: rt?.backends,
      toolFilter: rt?.toolFilter,
      extraTools: rt?.extraTools,
      extraSkills: rt?.extraSkills,
      mcpServers: channelDelegateMcpServers(cfg?.mcpServers, rt?.mcpServers),
      onChunk: (delta) => {
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
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
          transcriptTargetId: sessionId,
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
          transcriptTargetId: sessionId,
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
          transcriptTargetId: sessionId,
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
          transcriptTargetId: sessionId,
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
      })
      .finally(() => aborts.delete(sessionId));

    return { accepted: true as const };
  }

  async function forwardToNativeCli({
    sessionId,
    agentName,
    text,
    displayText
  }: {
    sessionId: TranscriptTargetId;
    agentName: string;
    text: string;
    displayText?: string;
  }) {
    const session = requireTranscriptTarget(sessionId);
    assertWriteAllowed(session, 'http');
    const userRound: Event[] = [];
    const userEmit = makeEmit(userRound);
    const userMsgId = newId('msg');
    userEmit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'user.message',
      actorAgentId: null,
      payload: { messageId: userMsgId, text: displayText ?? text },
      at: new Date().toISOString()
    });
    store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');
    persistAndRetire(sessionId, userRound);

    const emitNativeCliError = (err: unknown, fallbackCode?: string) => {
      const { code, message } = extractError(err);
      const agentMsgId = newId('msg');
      const round: Event[] = [];
      const emit = makeEmit(round);
      store.insertMessage(
        agentMsgId,
        sessionId,
        (code ?? fallbackCode) ? `[${code ?? fallbackCode}] ${message}` : message,
        new Date().toISOString(),
        'assistant',
        { type: 'error', data: { agentName } }
      );
      emit({
        id: newId('evt'),
        transcriptTargetId: sessionId,
        type: 'agent.error',
        actorAgentId: null,
        payload: { messageId: agentMsgId, agentName, code: code ?? fallbackCode, message },
        at: new Date().toISOString()
      });
      persistAndRetire(sessionId, round);
    };

    const paths = ctx.deps.paths;
    if (!paths) {
      emitNativeCliError(new HandlerError('internal', 'daemon paths not configured'));
      return { accepted: true as const };
    }
    const nativeCliHost = ctx.deps.nativeCliHost;
    if (!nativeCliHost) {
      emitNativeCliError(new HandlerError('internal', 'native CLI host not configured'));
      return { accepted: true as const };
    }
    const cfg = await loadAll(paths.config, paths.profile);
    const configuredNativeCliAgents = (cfg?.nativeCliAgents ?? []).filter(
      (agent: NativeCliAgentConfig) => agent.enabled !== false
    );
    const managedMember = managedNativeCliProjectMembers(session, configuredNativeCliAgents).find(
      (candidate) => candidate.runtimeAgentName === agentName || candidate.templateAgentName === agentName
    );
    const runtimeAgentName = managedMember?.runtimeAgentName ?? agentName;
    const templateAgentName = managedMember?.templateAgentName ?? agentName;
    const spec =
      managedMember?.spec ??
      configuredNativeCliAgents.find((agent: NativeCliAgentConfig) => agent.name === templateAgentName);
    if (!spec) {
      emitNativeCliError(new HandlerError('invalid', `native CLI agent "${agentName}" not found or disabled`));
      return { accepted: true as const };
    }
    if (!session.cwd) {
      emitNativeCliError(
        new HandlerError('invalid', `native CLI agent "${agentName}" requires a project working path`)
      );
      return { accepted: true as const };
    }
    log?.debug({ sessionId, event: 'session.forward_native_cli.start', agentName, text }, 'forward native cli start');
    try {
      const memberSettings = managedMember?.settings ?? nativeCliProjectMemberSettings(session, runtimeAgentName);
      const runtimeRole = memberSettings.managedProjectAgent ? 'managed-project-agent' : 'interactive';
      const nativeSessions = nativeCliHost
        .list(sessionId)
        .sessions.filter(
          (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === runtimeRole
        );
      const existing = nativeSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        nativeCliHost.input(existing.id, { input: text.endsWith('\n') ? text : `${text}\n` });
        log?.debug(
          { sessionId, event: 'session.forward_native_cli.accepted', agentName, nativeCliSessionId: existing.id },
          'forward native cli accepted'
        );
        return { accepted: true as const };
      }
      const preflight = await nativeCliHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const reason = preflight.reason;
        const round: Event[] = [];
        const emit = makeEmit(round);
        const agentMsgId = newId('msg');
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          emit({
            id: newId('evt'),
            transcriptTargetId: sessionId,
            type: 'native_cli.connection_required',
            actorAgentId: null,
            payload: {
              agentName,
              provider: spec.provider,
              reason,
              reconnectIn: 'studio'
            },
            at: new Date().toISOString()
          });
        }
        store.insertMessage(agentMsgId, sessionId, reason, new Date().toISOString(), 'assistant', {
          type: 'error',
          data: { agentName }
        });
        emit({
          id: newId('evt'),
          transcriptTargetId: sessionId,
          type: 'agent.error',
          actorAgentId: null,
          payload: {
            messageId: agentMsgId,
            agentName,
            code:
              preflight.state === 'not_authenticated'
                ? 'provider_auth_required'
                : preflight.state === 'unavailable'
                  ? 'provider_unavailable'
                  : 'provider_readiness_unknown',
            message: reason
          },
          at: new Date().toISOString()
        });
        persistAndRetire(sessionId, round);
        log?.debug(
          {
            sessionId,
            event: 'session.forward_native_cli.preflight_blocked',
            agentName,
            provider: spec.provider,
            state: preflight.state
          },
          'forward native cli connection required'
        );
        return { accepted: true as const };
      }
      const resumeFrom =
        runtimeRole === 'managed-project-agent'
          ? nativeSessions.find((candidate) => candidate.providerSessionRef)?.providerSessionRef
          : undefined;
      const nativeSession =
        runtimeRole === 'managed-project-agent'
          ? await startManagedNativeCliRuntimeWithRecovery({
              session,
              spec,
              runtimeAgentName,
              templateAgentName,
              displayName: nativeCliProjectMemberDisplayNameForAgent(session, runtimeAgentName),
              reasoningEffort: memberSettings.reasoningEffort,
              modelId: memberSettings.modelId ?? memberSettings.modelName,
              speed: memberSettings.speed,
              customPrompt: memberSettings.customPrompt,
              launchMode: managedProjectLaunchMode(spec, memberSettings.launchMode),
              providerSessionRef: resumeFrom ?? undefined,
              input: text
            })
          : await nativeCliHost.start({
              transcriptTargetId: sessionId,
              agentName: runtimeAgentName,
              templateAgentName,
              workingPath: session.cwd,
              launchMode: memberSettings.launchMode ?? spec.defaultLaunchMode,
              runtimeRole
            });
      if (runtimeRole !== 'managed-project-agent') {
        nativeCliHost.input(nativeSession.id, { input: text.endsWith('\n') ? text : `${text}\n` });
      }
      log?.debug(
        { sessionId, event: 'session.forward_native_cli.accepted', agentName, nativeCliSessionId: nativeSession.id },
        'forward native cli accepted'
      );
    } catch (err) {
      const { code, message } = extractError(err);
      log?.debug(
        { sessionId, event: 'session.forward_native_cli.error', agentName, code, message },
        'forward native cli error'
      );
      emitNativeCliError(err);
    }
    return { accepted: true as const };
  }

  return { forwardToAcp, forwardToNativeCli };
}

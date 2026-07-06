import type { NativeCliAgentConfig } from '@monad/home';
import type { Event, NativeCliSessionView, TranscriptTarget, TranscriptTargetId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
import {
  managedNativeCliProjectMembers,
  nativeCliProjectMemberDisplayNameForAgent,
  nativeCliProjectMemberSettings
} from '@/handlers/session/handlers/messaging-members.ts';
import { managedProjectLaunchMode } from '@/services/native-cli/managed-project.ts';

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
  allowAutopilot?: boolean;
  providerSessionRef?: string;
  input: string;
}) => Promise<NativeCliSessionView>;

// Access control reads the write policy STORED on the session (origin.writableBy) — mirrors the
// check in messaging.ts (kept local so this module has no import-cycle back to it).
function assertWriteAllowed(session: TranscriptTarget, transport: 'http'): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

/** Send text directly to a named native-CLI agent, bypassing the monad LLM/routing layer entirely. */
export function createForwardNativeCliHandler(
  ctx: SessionContext,
  startManagedNativeCliRuntimeWithRecovery: StartManagedNativeCliRuntimeWithRecovery
) {
  const {
    deps: { store, log },
    makeEmit,
    persistAndRetire,
    requireTranscriptTarget
  } = ctx;

  return async function forwardToNativeCli({
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
        await nativeCliHost.input(existing.id, { input: text.endsWith('\n') ? text : `${text}\n` });
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
              allowAutopilot: memberSettings.allowAutopilot,
              providerSessionRef: resumeFrom ?? undefined,
              input: text
            })
          : await nativeCliHost.start({
              transcriptTargetId: sessionId,
              agentName: runtimeAgentName,
              templateAgentName,
              workingPath: session.cwd,
              launchMode: memberSettings.launchMode ?? spec.defaultLaunchMode,
              appServerTransport: memberSettings.appServerTransport,
              allowAutopilot: memberSettings.allowAutopilot,
              runtimeRole
            });
      if (runtimeRole !== 'managed-project-agent') {
        await nativeCliHost.input(nativeSession.id, { input: text.endsWith('\n') ? text : `${text}\n` });
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
  };
}

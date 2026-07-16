import type { ExternalAgentConfig } from '@monad/environment';
import type { Event, ExternalAgentLaunchMode, ExternalAgentSessionView, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  externalAgentProjectMemberDisplayNameForAgent,
  externalAgentProjectMemberSettings,
  managedExternalAgentProjectMembers
} from '#/handlers/session/handlers/messaging-members.ts';
import { resolveExternalAgentDefaultLaunchMode } from '#/services/external-agent/index.ts';
import { managedProjectLaunchMode } from '#/services/external-agent/managed-project.ts';

type StartManagedExternalAgentRuntimeWithRecovery = (args: {
  session: Session;
  spec: ExternalAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  launchMode: ExternalAgentLaunchMode;
  allowAutopilot?: boolean;
  providerSessionRef?: string;
  input: string;
}) => Promise<ExternalAgentSessionView>;

// Access control reads the write policy STORED on the session (origin.writableBy) — mirrors the
// check in messaging.ts (kept local so this module has no import-cycle back to it).
function assertWriteAllowed(session: Session, transport: 'http'): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

/** Send text directly to a named external agent, bypassing the monad LLM/routing layer entirely. */
export function createForwardExternalAgentHandler(
  ctx: SessionContext,
  startManagedExternalAgentRuntimeWithRecovery: StartManagedExternalAgentRuntimeWithRecovery
) {
  const {
    deps: { store, log },
    makeEmit,
    persistAndRetire,
    requireSession
  } = ctx;

  return async function forwardToExternalAgent({
    sessionId,
    agentName,
    text,
    displayText
  }: {
    sessionId: SessionId;
    agentName: string;
    text: string;
    displayText?: string;
  }) {
    const session = requireSession(sessionId);
    assertWriteAllowed(session, 'http');
    const userRound: Event[] = [];
    const userEmit = makeEmit(userRound);
    const userMsgId = newId('msg');
    userEmit({
      id: newId('evt'),
      sessionId: sessionId as SessionId,
      type: 'user.message',
      actorAgentId: null,
      payload: { messageId: userMsgId, text: displayText ?? text },
      at: new Date().toISOString()
    });
    store.insertMessage(userMsgId, sessionId, displayText ?? text, new Date().toISOString(), 'user');
    persistAndRetire(sessionId, userRound);

    const emitExternalAgentError = (err: unknown, fallbackCode?: string) => {
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
        sessionId: sessionId as SessionId,
        type: 'agent.error',
        actorAgentId: null,
        payload: { messageId: agentMsgId, agentName, code: code ?? fallbackCode, message },
        at: new Date().toISOString()
      });
      persistAndRetire(sessionId, round);
    };

    const cfg = ctx.deps.configManager?.get().cfg;
    if (!cfg) {
      emitExternalAgentError(new HandlerError('internal', 'daemon config not configured'));
      return { accepted: true as const };
    }
    const externalAgentHost = ctx.deps.externalAgentHost;
    if (!externalAgentHost) {
      emitExternalAgentError(new HandlerError('internal', 'external agent host not configured'));
      return { accepted: true as const };
    }
    const configuredExternalAgents = cfg.externalAgents.filter((agent: ExternalAgentConfig) => agent.enabled !== false);
    const managedMember = managedExternalAgentProjectMembers(store, sessionId, configuredExternalAgents).find(
      (candidate) => candidate.runtimeAgentName === agentName || candidate.templateAgentName === agentName
    );
    const runtimeAgentName = managedMember?.runtimeAgentName ?? agentName;
    const templateAgentName = managedMember?.templateAgentName ?? agentName;
    const spec =
      managedMember?.spec ??
      configuredExternalAgents.find((agent: ExternalAgentConfig) => agent.name === templateAgentName);
    if (!spec) {
      emitExternalAgentError(new HandlerError('invalid', `external agent "${agentName}" not found or disabled`));
      return { accepted: true as const };
    }
    if (!session.cwd) {
      emitExternalAgentError(
        new HandlerError('invalid', `external agent "${agentName}" requires a project working path`)
      );
      return { accepted: true as const };
    }
    log?.debug(
      { sessionId, event: 'session.forward_external_agent.start', agentName, text },
      'forward native cli start'
    );
    try {
      const memberSettings =
        managedMember?.settings ?? externalAgentProjectMemberSettings(store, sessionId, runtimeAgentName);
      const runtimeRole = memberSettings.managedProjectAgent ? 'managed-project-agent' : 'interactive';
      const nativeSessions = externalAgentHost
        .list(sessionId)
        .sessions.filter(
          (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === runtimeRole
        );
      const existing = nativeSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        await externalAgentHost.input(existing.id, { input: text.endsWith('\n') ? text : `${text}\n` });
        log?.debug(
          {
            sessionId,
            event: 'session.forward_external_agent.accepted',
            agentName,
            externalAgentSessionId: existing.id
          },
          'forward native cli accepted'
        );
        return { accepted: true as const };
      }
      const preflight = await externalAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const reason = preflight.reason;
        const round: Event[] = [];
        const emit = makeEmit(round);
        const agentMsgId = newId('msg');
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          emit({
            id: newId('evt'),
            sessionId: sessionId as SessionId,
            type: 'external_agent.connection_required',
            actorAgentId: null,
            payload: {
              agentName,
              provider: spec.provider,
              code: 'provider_connection_required',
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
          sessionId: sessionId as SessionId,
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
            event: 'session.forward_external_agent.preflight_blocked',
            agentName,
            provider: spec.provider,
            state: preflight.state
          },
          'forward native cli connection required'
        );
        return { accepted: true as const };
      }
      const resumeCandidate =
        runtimeRole === 'managed-project-agent'
          ? nativeSessions.find((candidate) => candidate.providerSessionRef)
          : undefined;
      const resumeFrom = resumeCandidate?.providerSessionRef;
      if (resumeCandidate && resumeFrom) store.clearExternalAgentSessionRef(resumeCandidate.id);
      const nativeSession =
        runtimeRole === 'managed-project-agent'
          ? await startManagedExternalAgentRuntimeWithRecovery({
              session,
              spec,
              runtimeAgentName,
              templateAgentName,
              displayName: externalAgentProjectMemberDisplayNameForAgent(store, sessionId, runtimeAgentName),
              reasoningEffort: memberSettings.reasoningEffort,
              modelId: memberSettings.modelId ?? memberSettings.modelName,
              speed: memberSettings.speed,
              customPrompt: memberSettings.customPrompt,
              launchMode: managedProjectLaunchMode(spec, memberSettings.launchMode),
              allowAutopilot: memberSettings.allowAutopilot,
              providerSessionRef: resumeFrom ?? undefined,
              input: text
            })
          : await externalAgentHost.start({
              transcriptTargetId: sessionId,
              agentName: runtimeAgentName,
              templateAgentName,
              workingPath: session.cwd,
              launchMode: memberSettings.launchMode ?? resolveExternalAgentDefaultLaunchMode(spec.provider),
              appServerTransport: memberSettings.appServerTransport,
              allowAutopilot: memberSettings.allowAutopilot,
              runtimeRole
            });
      if (runtimeRole !== 'managed-project-agent') {
        await externalAgentHost.input(nativeSession.id, { input: text.endsWith('\n') ? text : `${text}\n` });
      }
      log?.debug(
        {
          sessionId,
          event: 'session.forward_external_agent.accepted',
          agentName,
          externalAgentSessionId: nativeSession.id
        },
        'forward native cli accepted'
      );
    } catch (err) {
      const { code, message } = extractError(err);
      log?.debug(
        { sessionId, event: 'session.forward_external_agent.error', agentName, code, message },
        'forward native cli error'
      );
      emitExternalAgentError(err);
    }
    return { accepted: true as const };
  };
}

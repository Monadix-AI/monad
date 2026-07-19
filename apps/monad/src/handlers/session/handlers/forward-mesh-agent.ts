import type { MeshAgentConfig } from '@monad/environment';
import type {
  Event,
  MeshAgentLaunchMode,
  MeshSessionView,
  MessageAttachment,
  Session,
  SessionId
} from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  managedMeshAgentProjectMembers,
  meshAgentProjectMemberConfiguredDisplayNameForAgent,
  meshAgentProjectMemberSettings
} from '#/handlers/session/handlers/messaging-members.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { resolveMeshAgentDefaultLaunchMode } from '#/services/mesh-agent/index.ts';
import { managedProjectLaunchMode } from '#/services/mesh-agent/managed-project.ts';

type StartManagedMeshAgentRuntimeWithRecovery = (args: {
  session: Session;
  spec: MeshAgentConfig;
  runtimeAgentName: string;
  templateAgentName: string;
  displayName?: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
  launchMode: MeshAgentLaunchMode;
  allowAutopilot?: boolean;
  providerSessionRef?: string;
  input: string;
}) => Promise<MeshSessionView>;

// Access control reads the write policy STORED on the session (origin.writableBy) — mirrors the
// check in messaging.ts (kept local so this module has no import-cycle back to it).
function assertWriteAllowed(session: Session, transport: 'http'): void {
  const writableBy = session.origin?.writableBy;
  if (!writableBy) return;
  if (!writableBy.includes(transport)) {
    throw new HandlerError('forbidden', `transport '${transport}' cannot write to this session`);
  }
}

/** Send text directly to a named MeshAgent, bypassing the monad LLM/routing layer entirely. */
export function createForwardMeshAgentHandler(
  ctx: SessionContext,
  startManagedMeshAgentRuntimeWithRecovery: StartManagedMeshAgentRuntimeWithRecovery
) {
  const {
    deps: { store, log },
    makeEmit,
    persistAndRetire,
    requireSession,
    messageIngress
  } = ctx;

  return async function forwardToMeshAgent({
    sessionId,
    agentName,
    text,
    displayText,
    attachments
  }: {
    sessionId: SessionId;
    agentName: string;
    text: string;
    displayText?: string;
    attachments?: MessageAttachment[];
  }) {
    const session = requireSession(sessionId);
    assertWriteAllowed(session, 'http');
    await messageIngress.deliver({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: { kind: 'user' },
      role: 'user',
      type: 'text',
      text: displayText ?? text,
      ...(attachments?.length ? { data: { attachments } } : {})
    });
    const emitMeshAgentError = async (err: unknown, fallbackCode?: string) => {
      const { code, message } = extractError(err);
      const errorText = (code ?? fallbackCode) ? `[${code ?? fallbackCode}] ${message}` : message;
      await messageIngress.deliver({
        transcriptTargetId: sessionId,
        idempotencyKey: newId('idem'),
        producer: { kind: 'system', subsystem: 'mesh-agent' },
        role: 'assistant',
        type: 'error',
        text: errorText,
        data: { agentName }
      });
    };

    const cfg = ctx.deps.configManager?.get().cfg;
    if (!cfg) {
      await emitMeshAgentError(new HandlerError('internal', 'daemon config not configured'));
      return { accepted: true as const };
    }
    const meshAgentHost = ctx.deps.meshAgentHost;
    if (!meshAgentHost) {
      await emitMeshAgentError(new HandlerError('internal', 'MeshAgent host not configured'));
      return { accepted: true as const };
    }
    const configuredMeshAgents = cfg.meshAgents.filter((agent: MeshAgentConfig) => agent.enabled !== false);
    const managedMember = managedMeshAgentProjectMembers(store, sessionId, configuredMeshAgents).find(
      (candidate) => candidate.runtimeAgentName === agentName || candidate.templateAgentName === agentName
    );
    const runtimeAgentName = managedMember?.runtimeAgentName ?? agentName;
    const templateAgentName = managedMember?.templateAgentName ?? agentName;
    const spec =
      managedMember?.spec ?? configuredMeshAgents.find((agent: MeshAgentConfig) => agent.name === templateAgentName);
    if (!spec) {
      await emitMeshAgentError(new HandlerError('invalid', `MeshAgent "${agentName}" not found or disabled`));
      return { accepted: true as const };
    }
    if (!session.cwd) {
      await emitMeshAgentError(new HandlerError('invalid', `MeshAgent "${agentName}" requires a project working path`));
      return { accepted: true as const };
    }
    log?.debug({ sessionId, event: 'session.forward_mesh.start', agentName, text }, 'forward native cli start');
    try {
      const memberSettings =
        managedMember?.settings ?? meshAgentProjectMemberSettings(store, sessionId, runtimeAgentName);
      const runtimeRole = memberSettings.managedProjectAgent ? 'managed-project-agent' : 'interactive';
      const nativeSessions = meshAgentHost
        .list(sessionId)
        .sessions.filter(
          (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === runtimeRole
        );
      const existing = nativeSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        await meshAgentHost.input(existing.id, { input: text.endsWith('\n') ? text : `${text}\n` });
        log?.debug(
          {
            sessionId,
            event: 'session.forward_mesh.accepted',
            agentName,
            meshSessionId: existing.id
          },
          'forward native cli accepted'
        );
        return { accepted: true as const };
      }
      const preflight = await meshAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const reason = preflight.reason;
        const round: Event[] = [];
        const emit = makeEmit(round);
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          emit(
            makeEvent(sessionId as SessionId, 'mesh.connection_required', {
              agentName,
              provider: spec.provider,
              code: 'provider_connection_required',
              reason,
              reconnectIn: 'studio'
            })
          );
        }
        await messageIngress.deliver({
          transcriptTargetId: sessionId,
          idempotencyKey: newId('idem'),
          producer: { kind: 'system', subsystem: 'mesh-agent' },
          role: 'assistant',
          type: 'error',
          text: reason,
          data: { agentName }
        });
        persistAndRetire(sessionId, round);
        log?.debug(
          {
            sessionId,
            event: 'session.forward_mesh.preflight_blocked',
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
      if (resumeCandidate && resumeFrom) store.clearMeshSessionRef(resumeCandidate.id);
      const nativeSession =
        runtimeRole === 'managed-project-agent'
          ? await startManagedMeshAgentRuntimeWithRecovery({
              session,
              spec,
              runtimeAgentName,
              templateAgentName,
              displayName: meshAgentProjectMemberConfiguredDisplayNameForAgent(store, sessionId, runtimeAgentName),
              reasoningEffort: memberSettings.reasoningEffort,
              modelId: memberSettings.modelId ?? memberSettings.modelName,
              speed: memberSettings.speed,
              customPrompt: memberSettings.customPrompt,
              launchMode: managedProjectLaunchMode(spec, memberSettings.launchMode),
              allowAutopilot: memberSettings.allowAutopilot,
              providerSessionRef: resumeFrom ?? undefined,
              input: text
            })
          : await meshAgentHost.start({
              transcriptTargetId: sessionId,
              agentName: runtimeAgentName,
              templateAgentName,
              workingPath: session.cwd,
              launchMode: memberSettings.launchMode ?? resolveMeshAgentDefaultLaunchMode(spec.provider),
              appServerTransport: memberSettings.appServerTransport,
              allowAutopilot: memberSettings.allowAutopilot,
              runtimeRole
            });
      if (runtimeRole !== 'managed-project-agent') {
        await meshAgentHost.input(nativeSession.id, { input: text.endsWith('\n') ? text : `${text}\n` });
      }
      log?.debug(
        {
          sessionId,
          event: 'session.forward_mesh.accepted',
          agentName,
          meshSessionId: nativeSession.id
        },
        'forward native cli accepted'
      );
    } catch (err) {
      const { code, message } = extractError(err);
      log?.debug(
        { sessionId, event: 'session.forward_mesh.error', agentName, code, message },
        'forward native cli error'
      );
      await emitMeshAgentError(err);
    }
    return { accepted: true as const };
  };
}

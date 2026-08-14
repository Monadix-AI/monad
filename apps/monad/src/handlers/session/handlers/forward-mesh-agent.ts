import type { MeshAgentConfig } from '@monad/environment';
import type { Event, MeshSessionView, MessageAttachment, MessageId, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { StartManagedMeshAgentRuntimeArgs } from '#/handlers/session/handlers/managed-mesh-agent-runtime.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import {
  AmbiguousMemberTargetError,
  managedMeshAgentProjectMembers,
  meshAgentProjectMemberConfiguredDisplayNameForAgent,
  meshAgentProjectMemberSettings,
  resolveManagedMember
} from '#/handlers/session/handlers/messaging-members.ts';
import { assertSessionWriteAuthority } from '#/handlers/session/transport-authority.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { enabledInvitableMeshAgentConfigs } from '#/services/mesh-agent/invitable-agents.ts';

type StartManagedMeshAgentRuntimeWithRecovery = (args: StartManagedMeshAgentRuntimeArgs) => Promise<MeshSessionView>;

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
    replyToMessageId,
    attachments
  }: {
    sessionId: SessionId;
    agentName: string;
    text: string;
    displayText?: string;
    replyToMessageId?: MessageId;
    attachments?: MessageAttachment[];
  }) {
    const session = requireSession(sessionId);
    assertSessionWriteAuthority(session);
    await messageIngress.deliver({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: { kind: 'user' },
      role: 'user',
      type: 'text',
      text: displayText ?? text,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
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
    const configuredMeshAgents = enabledInvitableMeshAgentConfigs(cfg);
    const managedCandidates = managedMeshAgentProjectMembers(store, sessionId, configuredMeshAgents);
    let managedMember: (typeof managedCandidates)[number] | undefined;
    try {
      managedMember = resolveManagedMember(managedCandidates, agentName);
    } catch (err) {
      if (err instanceof AmbiguousMemberTargetError) {
        // Keep the "accepted + transcript error" contract: the user message is already delivered, so an
        // ambiguous target must surface as a stable transcript conflict, never start a runtime or hard-reject.
        // The error carries its own AMBIGUOUS_MEMBER_TARGET code, so extractError surfaces it — no fallback.
        await emitMeshAgentError(err);
        return { accepted: true as const };
      }
      throw err;
    }
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
      const existing = nativeSessions.find((candidate) => candidate.lifecycle.state === 'active');
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
        if (preflight.state === 'not_authenticated') {
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
      // A managed-project-agent runtime must resolve to an owning ProjectMember. If the settings say
      // managed but no member resolves, fail closed — never start an unowned managed runtime and reverse
      // infer its owner later.
      if (runtimeRole === 'managed-project-agent' && !managedMember) {
        await emitMeshAgentError(
          new HandlerError(
            'invalid',
            `MeshAgent "${agentName}" cannot start as a managed project agent without a resolvable project member`
          )
        );
        return { accepted: true as const };
      }
      const nativeSession =
        runtimeRole === 'managed-project-agent' && managedMember
          ? await startManagedMeshAgentRuntimeWithRecovery({
              session,
              spec,
              projectMemberId: managedMember.projectMemberId,
              runtimeAgentName,
              templateAgentName,
              displayName: meshAgentProjectMemberConfiguredDisplayNameForAgent(store, sessionId, runtimeAgentName),
              workingDirectoryOverride: memberSettings.cwd,
              reasoningEffort: memberSettings.reasoningEffort,
              modelId: memberSettings.modelId ?? memberSettings.modelName,
              speed: memberSettings.speed,
              customPrompt: memberSettings.customPrompt,
              allowAutopilot: memberSettings.allowAutopilot,
              providerSessionRef: resumeFrom ?? undefined,
              input: text
            })
          : await meshAgentHost.start({
              transcriptTargetId: sessionId,
              agentName: runtimeAgentName,
              templateAgentName,
              workingPath: session.cwd,
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

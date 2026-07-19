import type { ManagedMeshAgentLifecycleLogEvent, Session } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ManagedMeshAgentProjectMember } from '#/handlers/session/handlers/messaging-members.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { definePrompt } from '#/agent/prompt-template.ts';
import { createManagedMeshAgentDelivery } from '#/handlers/session/handlers/managed-mesh-agent-delivery.ts';
import managedProjectJoinGreetingNoticePath from '#/services/mesh-agent/prompts/managed-project-join-greeting-user.prompt.md' with {
  type: 'file'
};

const MANAGED_MESH_AGENT_MEMBER_START_ERROR_EVENT =
  'project.managed_mesh.member_start_error' satisfies ManagedMeshAgentLifecycleLogEvent;
const MANAGED_MESH_AGENT_JOIN_GREETING_PROMPT = await definePrompt({
  id: 'managed-project.join-greeting.user',
  sourcePath: managedProjectJoinGreetingNoticePath
});

/** Cold-starts (or resumes) one managed-project-agent member's runtime for the given session and
 *  greets it with the join notice — the explicit-invite counterpart of a member joining a project.
 *  No-ops (returns `started: false`) if the member is already running, the host/cwd aren't ready,
 *  or the provider isn't authenticated (a `connection_required` lifecycle event is emitted instead). */
export function createManagedMeshAgentJoin(ctx: SessionContext) {
  const {
    deps: { store, paths, meshAgentHost, log },
    emitLifecycle,
    messageIngress
  } = ctx;
  const { emitManagedMeshAgentThinking, startManagedMeshAgentRuntimeWithRecovery } =
    createManagedMeshAgentDelivery(ctx);

  async function recordManagedMeshAgentProjectError(
    sessionId: Session['id'],
    agentName: string,
    message: string
  ): Promise<void> {
    const text = `${agentName} failed to join the project: ${message}`;
    await messageIngress.deliver({
      transcriptTargetId: sessionId,
      idempotencyKey: newId('idem'),
      producer: { kind: 'system', subsystem: 'managed-mesh-agent' },
      role: 'assistant',
      type: 'error',
      text,
      data: { agentName }
    });
  }

  async function spawnManagedSessionMember(
    session: Session,
    member: ManagedMeshAgentProjectMember
  ): Promise<{ started: boolean; nativeSessionId?: string }> {
    if (!meshAgentHost || !paths || !session.cwd) return { started: false };
    const { spec, runtimeAgentName, templateAgentName, displayName, configuredDisplayName, settings } = member;
    const managedSessions = meshAgentHost
      .list(session.id)
      .sessions.filter(
        (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === 'managed-project-agent'
      );
    if (managedSessions.some((candidate) => candidate.lifecycle.state === 'active')) return { started: false };
    try {
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await meshAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          emitLifecycle(session.id, 'mesh.connection_required', {
            agentName: runtimeAgentName,
            provider: spec.provider,
            code: 'provider_connection_required',
            reason: preflight.reason,
            reconnectIn: 'studio'
          });
        }
        return { started: false };
      }
      if (resumeCandidate && resumeFrom) store.clearMeshSessionRef(resumeCandidate.id);
      const nativeSession = await startManagedMeshAgentRuntimeWithRecovery({
        session,
        spec,
        runtimeAgentName,
        templateAgentName,
        displayName: configuredDisplayName,
        modelName: settings.modelName ?? settings.modelId,
        modelId: settings.modelId,
        reasoningEffort: settings.reasoningEffort,
        speed: settings.speed,
        customPrompt: settings.customPrompt,
        allowAutopilot: settings.allowAutopilot,
        providerSessionRef: resumeFrom ?? undefined,
        input: MANAGED_MESH_AGENT_JOIN_GREETING_PROMPT.render({})
      });
      await emitManagedMeshAgentThinking(session.id, nativeSession.id, runtimeAgentName, undefined, displayName);
      return { started: true, nativeSessionId: nativeSession.id };
    } catch (err) {
      const { message } = extractError(err);
      await recordManagedMeshAgentProjectError(session.id, runtimeAgentName, message);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_MESH_AGENT_MEMBER_START_ERROR_EVENT,
          agentName: runtimeAgentName,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
        },
        'managed native cli member start failed'
      );
      return { started: false };
    }
  }

  return { spawnManagedSessionMember };
}

import type { ManagedExternalAgentLifecycleLogEvent, Session } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';
import type { ManagedExternalAgentProjectMember } from '@/handlers/session/handlers/messaging-members.ts';

import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { createManagedExternalAgentDelivery } from '@/handlers/session/handlers/managed-external-agent-delivery.ts';
import { managedProjectLaunchMode } from '@/services/external-agent/managed-project.ts';
import managedProjectJoinGreetingNoticePath from '@/services/external-agent/prompts/managed-project-join-greeting-notice.md' with {
  type: 'file'
};

const MANAGED_EXTERNAL_AGENT_MEMBER_START_ERROR_EVENT =
  'project.managed_external_agent.member_start_error' satisfies ManagedExternalAgentLifecycleLogEvent;
const MANAGED_EXTERNAL_AGENT_JOIN_GREETING_NOTICE = (
  await Bun.file(managedProjectJoinGreetingNoticePath).text()
).trim();

/** Cold-starts (or resumes) one managed-project-agent member's runtime for the given session and
 *  greets it with the join notice — the explicit-invite counterpart of a member joining a project.
 *  No-ops (returns `started: false`) if the member is already running, the host/cwd aren't ready,
 *  or the provider isn't authenticated (a `connection_required` lifecycle event is emitted instead). */
export function createManagedExternalAgentJoin(ctx: SessionContext) {
  const {
    deps: { store, paths, externalAgentHost, log },
    emitLifecycle
  } = ctx;
  const { emitManagedExternalAgentThinking, startManagedExternalAgentRuntimeWithRecovery } =
    createManagedExternalAgentDelivery(ctx);

  function recordManagedExternalAgentProjectError(sessionId: Session['id'], agentName: string, message: string): void {
    const text = `${agentName} failed to join the project: ${message}`;
    const messageId = newId('msg');
    store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
      type: 'error',
      data: { agentName }
    });
    emitLifecycle(sessionId, 'agent.error', {
      messageId,
      agentName,
      code: 'managed_external_agent_start_failed',
      message: text
    });
  }

  async function spawnManagedSessionMember(
    session: Session,
    member: ManagedExternalAgentProjectMember
  ): Promise<{ started: boolean; nativeSessionId?: string }> {
    if (!externalAgentHost || !paths || !session.cwd) return { started: false };
    const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
    const managedSessions = externalAgentHost
      .list(session.id)
      .sessions.filter(
        (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === 'managed-project-agent'
      );
    if (managedSessions.some((candidate) => candidate.state === 'running')) return { started: false };
    try {
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await externalAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          emitLifecycle(session.id, 'external_agent.connection_required', {
            agentName: runtimeAgentName,
            provider: spec.provider,
            code: 'provider_connection_required',
            reason: preflight.reason,
            reconnectIn: 'studio'
          });
        }
        return { started: false };
      }
      if (resumeCandidate && resumeFrom) store.clearExternalAgentSessionRef(resumeCandidate.id);
      const nativeSession = await startManagedExternalAgentRuntimeWithRecovery({
        session,
        spec,
        runtimeAgentName,
        templateAgentName,
        displayName,
        modelName: settings.modelName ?? settings.modelId,
        modelId: settings.modelId,
        reasoningEffort: settings.reasoningEffort,
        speed: settings.speed,
        customPrompt: settings.customPrompt,
        launchMode: managedProjectLaunchMode(spec, settings.launchMode),
        allowAutopilot: settings.allowAutopilot,
        providerSessionRef: resumeFrom ?? undefined,
        input: MANAGED_EXTERNAL_AGENT_JOIN_GREETING_NOTICE
      });
      emitManagedExternalAgentThinking(session.id, nativeSession.id, runtimeAgentName);
      return { started: true, nativeSessionId: nativeSession.id };
    } catch (err) {
      const { message } = extractError(err);
      recordManagedExternalAgentProjectError(session.id, runtimeAgentName, message);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_EXTERNAL_AGENT_MEMBER_START_ERROR_EVENT,
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

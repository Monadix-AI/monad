import type { ManagedExternalAgentLifecycleLogEvent, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';
import type { Store } from '@/store/db/index.ts';

import { loadAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { createManagedExternalAgentDelivery } from '@/handlers/session/handlers/managed-external-agent-delivery.ts';
import {
  externalAgentProjectMemberRuntimeName,
  managedExternalAgentProjectMembers,
  workplaceProjectMembers
} from '@/handlers/session/handlers/messaging-members.ts';
import { managedProjectLaunchMode } from '@/services/external-agent/managed-project.ts';
import managedProjectJoinGreetingNoticePath from '@/services/external-agent/prompts/managed-project-join-greeting-notice.md' with {
  type: 'file'
};

const MANAGED_EXTERNAL_AGENT_MEMBER_START_ERROR_EVENT =
  'project.managed_external_agent.member_start_error' satisfies ManagedExternalAgentLifecycleLogEvent;
const MANAGED_EXTERNAL_AGENT_JOIN_GREETING_NOTICE = (
  await Bun.file(managedProjectJoinGreetingNoticePath).text()
).trim();

function managedExternalAgentMemberRuntimeNames(store: Store, sessionId: SessionId): Set<string> {
  return new Set(
    workplaceProjectMembers(store, sessionId)
      .filter((member) => member.type === 'external-agent' && member.settings?.managedProjectAgent !== false)
      .map(externalAgentProjectMemberRuntimeName)
  );
}

/** Starts a managed-project-agent external agent runtime for every project member added between `previous`
 *  and `next` (diffed by workplace-project-members ext on session/project origin), greeting each with
 *  the join notice. */
export function createManagedExternalAgentJoin(ctx: SessionContext) {
  const {
    deps: { store, paths, externalAgentHost, log },
    emitLifecycle
  } = ctx;
  const { emitManagedExternalAgentThinking, startManagedExternalAgentRuntimeWithRecovery } =
    createManagedExternalAgentDelivery(ctx);

  function recordManagedExternalAgentProjectError(sessionId: SessionId, agentName: string, message: string): void {
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

  async function startAddedManagedExternalAgentMembers(previous: Session, next: Session): Promise<void> {
    if (!externalAgentHost || !paths || !next.cwd) return;
    const before = previous.cwd ? managedExternalAgentMemberRuntimeNames(store, previous.id) : new Set<string>();
    const cfg = await loadAll(paths.config, paths.profile);
    const agents = (cfg?.externalAgents ?? []).filter((agent) => agent.enabled !== false);
    const added = managedExternalAgentProjectMembers(store, next.id, agents).filter(
      (member) => !before.has(member.runtimeAgentName)
    );
    for (const member of added) {
      const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
      const managedSessions = externalAgentHost
        .list(next.id)
        .sessions.filter(
          (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === 'managed-project-agent'
        );
      if (managedSessions.some((candidate) => candidate.state === 'running')) continue;
      try {
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        const resumeFrom = resumeCandidate?.providerSessionRef;
        const preflight = await externalAgentHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            emitLifecycle(next.id, 'external_agent.connection_required', {
              agentName: runtimeAgentName,
              provider: spec.provider,
              code: 'provider_connection_required',
              reason: preflight.reason,
              reconnectIn: 'studio'
            });
          }
          continue;
        }
        if (resumeCandidate && resumeFrom) store.clearExternalAgentSessionRef(resumeCandidate.id);
        const nativeSession = await startManagedExternalAgentRuntimeWithRecovery({
          session: next,
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
        emitManagedExternalAgentThinking(next.id, nativeSession.id, runtimeAgentName);
      } catch (err) {
        const { message } = extractError(err);
        recordManagedExternalAgentProjectError(next.id, runtimeAgentName, message);
        log?.debug(
          {
            sessionId: next.id,
            event: MANAGED_EXTERNAL_AGENT_MEMBER_START_ERROR_EVENT,
            agentName: runtimeAgentName,
            err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
          },
          'managed native cli member start failed'
        );
      }
    }
  }

  return { startAddedManagedExternalAgentMembers };
}

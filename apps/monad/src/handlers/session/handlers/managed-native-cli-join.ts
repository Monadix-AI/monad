import type {
  ManagedNativeCliLifecycleLogEvent,
  NativeCliProvider,
  TranscriptTarget,
  TranscriptTargetId
} from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { createManagedNativeCliDelivery } from '@/handlers/session/handlers/managed-native-cli-delivery.ts';
import {
  managedNativeCliProjectMembers,
  nativeCliProjectMemberRuntimeName,
  workplaceProjectMembers
} from '@/handlers/session/handlers/messaging-members.ts';
import { findNativeCliProviderAdapter } from '@/services/native-cli/index.ts';
import { managedProjectLaunchMode } from '@/services/native-cli/managed-project.ts';
import managedProjectJoinGreetingNoticePath from '@/services/native-cli/prompts/managed-project-join-greeting-notice.md' with {
  type: 'file'
};
import managedProjectJoinGreetingNoticeMcpPath from '@/services/native-cli/prompts/managed-project-join-greeting-notice-mcp.md' with {
  type: 'file'
};

const MANAGED_NATIVE_CLI_MEMBER_START_ERROR_EVENT =
  'project.managed_native_cli.member_start_error' satisfies ManagedNativeCliLifecycleLogEvent;
const MANAGED_NATIVE_CLI_JOIN_GREETING_NOTICE = (await Bun.file(managedProjectJoinGreetingNoticePath).text()).trim();
const MANAGED_NATIVE_CLI_JOIN_GREETING_MCP_NOTICE = (
  await Bun.file(managedProjectJoinGreetingNoticeMcpPath).text()
).trim();

function managedNativeCliJoinGreetingNotice(provider: string): string {
  return findNativeCliProviderAdapter(provider as NativeCliProvider)?.managedRuntime?.usesManagedMcpBridge
    ? MANAGED_NATIVE_CLI_JOIN_GREETING_MCP_NOTICE
    : MANAGED_NATIVE_CLI_JOIN_GREETING_NOTICE;
}

function managedNativeCliMemberRuntimeNames(target: TranscriptTarget): Set<string> {
  return new Set(
    workplaceProjectMembers(target)
      .filter((member) => member.type === 'native-cli' && member.settings?.managedProjectAgent !== false)
      .map(nativeCliProjectMemberRuntimeName)
  );
}

/** Starts a managed-project-agent native CLI runtime for every project member added between `previous`
 *  and `next` (diffed by workplace-project-members ext on session/project origin), greeting each with
 *  the join notice. */
export function createManagedNativeCliJoin(ctx: SessionContext) {
  const {
    deps: { store, paths, nativeCliHost, log },
    emitLifecycle
  } = ctx;
  const { emitManagedNativeCliThinking, startManagedNativeCliRuntimeWithRecovery } =
    createManagedNativeCliDelivery(ctx);

  function recordManagedNativeCliProjectError(sessionId: TranscriptTargetId, agentName: string, message: string): void {
    const text = `${agentName} failed to join the project: ${message}`;
    const messageId = newId('msg');
    store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
      type: 'error',
      data: { agentName }
    });
    emitLifecycle(sessionId, 'agent.error', {
      messageId,
      agentName,
      code: 'managed_native_cli_start_failed',
      message: text
    });
  }

  async function startAddedManagedNativeCliMembers(previous: TranscriptTarget, next: TranscriptTarget): Promise<void> {
    if (!nativeCliHost || !paths || !next.cwd) return;
    const before = managedNativeCliMemberRuntimeNames(previous);
    const cfg = await loadAll(paths.config, paths.profile);
    const agents = (cfg?.nativeCliAgents ?? []).filter((agent) => agent.enabled !== false);
    const added = managedNativeCliProjectMembers(next, agents).filter((member) => !before.has(member.runtimeAgentName));
    for (const member of added) {
      const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
      const managedSessions = nativeCliHost
        .list(next.id)
        .sessions.filter(
          (candidate) => candidate.agentName === runtimeAgentName && candidate.runtimeRole === 'managed-project-agent'
        );
      if (managedSessions.some((candidate) => candidate.state === 'running')) continue;
      try {
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        const resumeFrom = resumeCandidate?.providerSessionRef;
        const preflight = await nativeCliHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            emitLifecycle(next.id, 'native_cli.connection_required', {
              agentName: runtimeAgentName,
              provider: spec.provider,
              reason: preflight.reason,
              reconnectIn: 'studio'
            });
          }
          continue;
        }
        if (resumeCandidate && resumeFrom) store.clearNativeCliSessionRef(resumeCandidate.id);
        const nativeSession = await startManagedNativeCliRuntimeWithRecovery({
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
          providerSessionRef: resumeFrom ?? undefined,
          input: managedNativeCliJoinGreetingNotice(spec.provider)
        });
        emitManagedNativeCliThinking(next.id, nativeSession.id, runtimeAgentName);
      } catch (err) {
        const { message } = extractError(err);
        recordManagedNativeCliProjectError(next.id, runtimeAgentName, message);
        log?.debug(
          {
            sessionId: next.id,
            event: MANAGED_NATIVE_CLI_MEMBER_START_ERROR_EVENT,
            agentName: runtimeAgentName,
            err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
          },
          'managed native cli member start failed'
        );
      }
    }
  }

  return { startAddedManagedNativeCliMembers };
}

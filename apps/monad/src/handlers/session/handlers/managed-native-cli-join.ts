import type { NativeCliAgentConfig } from '@monad/home';
import type { Event, ManagedNativeCliLifecycleLogEvent, SessionOrigin, TranscriptTargetId } from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';

import { loadAll } from '@monad/home';
import { newId, workplaceProjectMembersExtKey, workplaceProjectMembersExtSchema } from '@monad/protocol';

import { managedProjectLaunchMode } from '@/services/native-cli/managed-project.ts';
import managedProjectJoinGreetingNoticePath from '@/services/native-cli/prompts/managed-project-join-greeting-notice.md' with {
  type: 'file'
};

const MANAGED_NATIVE_CLI_MEMBER_START_ERROR_EVENT =
  'project.managed_native_cli.member_start_error' satisfies ManagedNativeCliLifecycleLogEvent;
const MANAGED_NATIVE_CLI_JOIN_GREETING_NOTICE = (await Bun.file(managedProjectJoinGreetingNoticePath).text()).trim();

type NativeCliMemberContainer = {
  id: TranscriptTargetId;
  cwd?: string;
  origin?: SessionOrigin;
};

function managedNativeCliMembers(origin: SessionOrigin | null | undefined) {
  const parsed = workplaceProjectMembersExtSchema.safeParse(origin?.ext?.[workplaceProjectMembersExtKey]);
  if (!parsed.success) return [];
  return parsed.data.filter((member) => member.type === 'native-cli' && member.settings?.managedProjectAgent !== false);
}

function nativeCliMemberTemplateName(member: ReturnType<typeof managedNativeCliMembers>[number]): string {
  return member.templateName ?? member.name;
}

function nativeCliMemberRuntimeName(member: ReturnType<typeof managedNativeCliMembers>[number]): string {
  return member.instanceId ?? member.name;
}

function nativeCliMemberDisplayName(member: ReturnType<typeof managedNativeCliMembers>[number]): string {
  return member.displayName ?? member.name;
}

function nativeCliMemberInstanceKey(member: ReturnType<typeof managedNativeCliMembers>[number]): string {
  return member.instanceId ?? nativeCliMemberRuntimeName(member);
}

function nativeCliInputText(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

function managedNativeCliJoinGreetingNotice(): string {
  return MANAGED_NATIVE_CLI_JOIN_GREETING_NOTICE;
}

/** Starts a managed-project-agent native CLI runtime for every project member added between `previous`
 *  and `next` (diffed by workplace-project-members ext on session/project origin), greeting each with
 *  the join notice. */
export function createManagedNativeCliJoin(ctx: SessionContext) {
  const {
    deps: { store, paths, nativeCliHost, log },
    makeEmit,
    persistAndRetire,
    emitLifecycle
  } = ctx;

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

  function emitManagedNativeCliJoinThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string
  ): void {
    const existing = store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    if (existing) return;
    const messageId = newId('msg');
    store.insertMessage(messageId, sessionId, '', new Date().toISOString(), 'assistant', {
      data: { agentName, nativeCliSessionId, reasoning: 'Thinking', source: 'managed-native-cli' },
      includeInContext: false,
      streamStatus: 'streaming'
    });
    const round: Event[] = [];
    const emit = makeEmit(round);
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.token',
      actorAgentId: null,
      payload: { messageId, agentName, delta: '', index: 0, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    emit({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.reasoning',
      actorAgentId: null,
      payload: { messageId, delta: 'Thinking', index: 0, source: 'managed-native-cli' },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
  }

  async function startAddedManagedNativeCliMembers(
    previous: NativeCliMemberContainer,
    next: NativeCliMemberContainer
  ): Promise<void> {
    if (!nativeCliHost || !paths || !next.cwd) return;
    const before = new Set(managedNativeCliMembers(previous.origin).map(nativeCliMemberInstanceKey));
    const added = managedNativeCliMembers(next.origin).filter(
      (member) => !before.has(nativeCliMemberInstanceKey(member))
    );
    if (added.length === 0) return;
    const cfg = await loadAll(paths.config, paths.profile);
    const configured = new Map(
      (cfg?.nativeCliAgents ?? [])
        .filter((agent: NativeCliAgentConfig) => agent.enabled !== false)
        .map((agent: NativeCliAgentConfig) => [agent.name, agent])
    );
    for (const member of added) {
      const templateAgentName = nativeCliMemberTemplateName(member);
      const runtimeAgentName = nativeCliMemberRuntimeName(member);
      const spec = configured.get(templateAgentName);
      if (!spec) continue;
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
        const startArgs = {
          transcriptTargetId: next.id,
          agentName: runtimeAgentName,
          displayName: nativeCliMemberDisplayName(member),
          templateAgentName,
          workingPath: next.cwd,
          launchMode: managedProjectLaunchMode(spec, member.settings?.launchMode),
          runtimeRole: 'managed-project-agent' as const,
          modelName: member.settings?.modelName ?? member.settings?.modelId,
          reasoningEffort: member.settings?.reasoningEffort,
          modelId: member.settings?.modelId,
          speed: member.settings?.speed,
          customPrompt: member.settings?.customPrompt
        };
        if (resumeCandidate && resumeFrom) store.clearNativeCliSessionRef(resumeCandidate.id);
        try {
          const nativeSession = await nativeCliHost.start({
            ...startArgs,
            providerSessionRef: resumeFrom ?? undefined
          });
          emitManagedNativeCliJoinThinking(next.id, nativeSession.id, runtimeAgentName);
          nativeCliHost.input(nativeSession.id, {
            input: nativeCliInputText(managedNativeCliJoinGreetingNotice())
          });
        } catch (err) {
          if (!resumeFrom) throw err;
          emitLifecycle(next.id, 'native_cli.resume_failed', {
            agentName: runtimeAgentName,
            provider: spec.provider,
            providerSessionRef: resumeFrom,
            message: err instanceof Error ? err.message : String(err),
            fallback: 'cold-start'
          });
          const nativeSession = await nativeCliHost.start(startArgs);
          emitManagedNativeCliJoinThinking(next.id, nativeSession.id, runtimeAgentName);
          nativeCliHost.input(nativeSession.id, {
            input: nativeCliInputText(managedNativeCliJoinGreetingNotice())
          });
        }
      } catch (err) {
        recordManagedNativeCliProjectError(next.id, runtimeAgentName, err instanceof Error ? err.message : String(err));
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

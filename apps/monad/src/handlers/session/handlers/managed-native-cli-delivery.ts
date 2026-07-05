import type { NativeCliAgentConfig } from '@monad/home';
import type {
  Event,
  ManagedNativeCliLifecycleLogEvent,
  ProjectId,
  TranscriptTarget,
  TranscriptTargetId
} from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';
import type { ManagedNativeCliProjectMessageSender } from '@/handlers/session/handlers/messaging-notices.ts';

import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
import { createManagedNativeCliMessages } from '@/handlers/session/handlers/managed-native-cli-messages.ts';
import { createManagedNativeCliRuntime } from '@/handlers/session/handlers/managed-native-cli-runtime.ts';
import { managedNativeCliProjectMembers } from '@/handlers/session/handlers/messaging-members.ts';
import {
  managedNativeCliBusyInboxNotice,
  managedNativeCliDirectNotice,
  managedNativeCliInboxNotice,
  nativeCliInputText,
  normalizeManagedNativeCliDirectTarget
} from '@/handlers/session/handlers/messaging-notices.ts';
import { managedProjectLaunchMode } from '@/services/native-cli/managed-project.ts';

const MANAGED_NATIVE_CLI_DELIVERY_ERROR_EVENT =
  'project.managed_native_cli.delivery_error' satisfies ManagedNativeCliLifecycleLogEvent;
const MANAGED_NATIVE_CLI_DIRECT_DELIVERY_ERROR_EVENT =
  'project.managed_native_cli.direct_delivery_error' satisfies ManagedNativeCliLifecycleLogEvent;

export function createManagedNativeCliDelivery(ctx: SessionContext) {
  const {
    deps: { store, log, nativeCliHost },
    makeEmit,
    persistAndRetire
  } = ctx;

  const { managedNativeCliSessionsForAgent, startManagedNativeCliRuntimeWithRecovery } =
    createManagedNativeCliRuntime(ctx);
  const { emitManagedNativeCliThinking, completeManagedNativeCliThinking, retireManagedNativeCliThinking } =
    createManagedNativeCliMessages(ctx);

  function recordManagedNativeCliProjectDeliveryError(
    sessionId: TranscriptTargetId,
    agentName: string,
    code: string | undefined,
    message: string
  ): void {
    const text = `${agentName} failed to process the project message: ${message}`;
    const messageId = newId('msg');
    const round: Event[] = [];
    store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
      type: 'error',
      data: { agentName }
    });
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.error',
      actorAgentId: null,
      payload: {
        messageId,
        agentName,
        code: code ?? 'managed_native_cli_delivery_failed',
        message: text
      },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
  }

  async function deliverProjectMessageToManagedNativeCliMembers({
    session,
    nativeCliAgents,
    text,
    sender,
    exceptAgentName
  }: {
    session: TranscriptTarget;
    nativeCliAgents: readonly NativeCliAgentConfig[];
    text: string;
    sender?: ManagedNativeCliProjectMessageSender;
    exceptAgentName?: string;
  }): Promise<void> {
    const managedMembers = managedNativeCliProjectMembers(session, nativeCliAgents);
    if (managedMembers.length === 0) return;
    const resolvedSender =
      sender?.kind === 'native-cli-agent'
        ? {
            ...sender,
            name:
              managedMembers.find((member) => member.runtimeAgentName === (sender.id ?? sender.name))?.displayName ??
              sender.name
          }
        : sender;
    if (!nativeCliHost || !session.cwd) return;
    for (const member of managedMembers) {
      const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
      if (runtimeAgentName === exceptAgentName) continue;
      try {
        const notice = managedNativeCliInboxNotice(member, text, resolvedSender);
        const deliveredSeq = store.maxMessageSeq(session.id);
        const triggerMessageId =
          deliveredSeq > 0 ? (store.messageIdForSeq(session.id, deliveredSeq) ?? undefined) : undefined;
        const deliveryId = deliveredSeq > 0 ? newId('deliv') : undefined;
        const managedSessions = managedNativeCliSessionsForAgent(session.id, runtimeAgentName);
        const existing = managedSessions.find((candidate) => candidate.state === 'running');
        if (existing) {
          if (deliveredSeq > 0) {
            store.enqueueNativeCliInboxItem(existing.id, deliveredSeq, {
              deliveryId,
              projectId: session.id as ProjectId,
              memberInstanceId: runtimeAgentName,
              triggerMessageId,
              providerSessionRef: existing.providerSessionRef ?? null
            });
          }
          emitManagedNativeCliThinking(session.id, existing.id, runtimeAgentName, deliveryId);
          if (existing.launchMode === 'cli-oneshot') {
            // cli-oneshot has no persistent process polling the inbox between turns, so every project
            // message must spawn a fresh turn carrying the message itself — the inbox-poll nudge path
            // (used by persistent members) would silently drop it.
            nativeCliHost.input(existing.id, { input: nativeCliInputText(notice) });
            if (deliveredSeq > 0) store.markNativeCliInboxVisible(existing.id, deliveredSeq);
          } else if (existing.lastDeliveredSeq === 0) {
            nativeCliHost.input(existing.id, { input: nativeCliInputText(notice) });
            if (deliveredSeq > 0) store.markNativeCliInboxVisible(existing.id, deliveredSeq);
          } else if (existing.lastDeliveredSeq <= existing.lastVisibleSeq) {
            nativeCliHost.input(existing.id, {
              input: nativeCliInputText(managedNativeCliBusyInboxNotice(member, resolvedSender))
            });
          }
          store.markNativeCliInboxDelivered(existing.id, deliveredSeq);
          continue;
        }
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        const resumeFrom = resumeCandidate?.providerSessionRef;
        const preflight = await nativeCliHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          const round: Event[] = [];
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            makeEmit(round)({
              id: newId('evt'),
              transcriptTargetId: session.id,
              type: 'native_cli.connection_required',
              actorAgentId: null,
              payload: {
                agentName: runtimeAgentName,
                provider: spec.provider,
                reason: preflight.reason,
                reconnectIn: 'studio'
              },
              at: new Date().toISOString()
            });
            persistAndRetire(session.id, round);
          }
          continue;
        }
        if (resumeCandidate && resumeFrom) store.clearNativeCliSessionRef(resumeCandidate.id);
        const nativeSession = await startManagedNativeCliRuntimeWithRecovery({
          session,
          spec,
          runtimeAgentName,
          templateAgentName,
          displayName,
          reasoningEffort: settings.reasoningEffort,
          modelId: settings.modelId ?? settings.modelName,
          speed: settings.speed,
          customPrompt: settings.customPrompt,
          launchMode: managedProjectLaunchMode(spec, settings.launchMode),
          appServerTransport: settings.appServerTransport,
          allowAutopilot: settings.allowAutopilot,
          providerSessionRef: resumeFrom ?? undefined,
          input: notice
        });
        if (deliveredSeq > 0) {
          store.enqueueNativeCliInboxItem(nativeSession.id, deliveredSeq, {
            deliveryId,
            projectId: session.id as ProjectId,
            memberInstanceId: runtimeAgentName,
            triggerMessageId,
            providerSessionRef: nativeSession.providerSessionRef ?? resumeFrom ?? null
          });
        }
        store.markNativeCliInboxDelivered(nativeSession.id, deliveredSeq);
        store.markNativeCliInboxVisible(nativeSession.id, deliveredSeq);
        emitManagedNativeCliThinking(session.id, nativeSession.id, runtimeAgentName, deliveryId);
      } catch (err) {
        const { code, message } = extractError(err);
        recordManagedNativeCliProjectDeliveryError(session.id, runtimeAgentName, code, message);
        log?.debug(
          {
            sessionId: session.id,
            event: MANAGED_NATIVE_CLI_DELIVERY_ERROR_EVENT,
            agentName: runtimeAgentName,
            code,
            message
          },
          'managed native cli project delivery failed'
        );
      }
    }
  }

  async function deliverDirectMessageToManagedNativeCliMember({
    session,
    nativeCliAgents,
    fromAgentName,
    to,
    text
  }: {
    session: TranscriptTarget;
    nativeCliAgents: readonly NativeCliAgentConfig[];
    fromAgentName: string;
    to: string;
    text: string;
  }): Promise<void> {
    const targetName = normalizeManagedNativeCliDirectTarget(to);
    if (!targetName || targetName === fromAgentName) return;
    const member = managedNativeCliProjectMembers(session, nativeCliAgents).find(
      (candidate) => candidate.runtimeAgentName === targetName
    );
    if (!member) return;
    const { spec, runtimeAgentName, templateAgentName, displayName, settings } = member;
    if (!nativeCliHost || !session.cwd) return;
    try {
      const notice = managedNativeCliDirectNotice({ member, fromAgentName, text });
      const managedSessions = managedNativeCliSessionsForAgent(session.id, runtimeAgentName);
      const existing = managedSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        nativeCliHost.input(existing.id, { input: nativeCliInputText(notice) });
        return;
      }
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await nativeCliHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const round: Event[] = [];
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          makeEmit(round)({
            id: newId('evt'),
            transcriptTargetId: session.id,
            type: 'native_cli.connection_required',
            actorAgentId: null,
            payload: {
              agentName: runtimeAgentName,
              provider: spec.provider,
              reason: preflight.reason,
              reconnectIn: 'studio'
            },
            at: new Date().toISOString()
          });
          persistAndRetire(session.id, round);
        }
        return;
      }
      if (resumeCandidate && resumeFrom) store.clearNativeCliSessionRef(resumeCandidate.id);
      await startManagedNativeCliRuntimeWithRecovery({
        session,
        spec,
        runtimeAgentName,
        templateAgentName,
        displayName,
        reasoningEffort: settings.reasoningEffort,
        modelId: settings.modelId ?? settings.modelName,
        speed: settings.speed,
        customPrompt: settings.customPrompt,
        launchMode: managedProjectLaunchMode(spec, settings.launchMode),
        appServerTransport: settings.appServerTransport,
        allowAutopilot: settings.allowAutopilot,
        providerSessionRef: resumeFrom ?? undefined,
        input: notice
      });
    } catch (err) {
      const { code, message } = extractError(err);
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_NATIVE_CLI_DIRECT_DELIVERY_ERROR_EVENT,
          fromAgentName,
          to,
          code,
          message
        },
        'managed native cli direct delivery failed'
      );
    }
  }

  return {
    emitManagedNativeCliThinking,
    completeManagedNativeCliThinking,
    retireManagedNativeCliThinking,
    deliverProjectMessageToManagedNativeCliMembers,
    deliverDirectMessageToManagedNativeCliMember,
    managedNativeCliSessionsForAgent,
    startManagedNativeCliRuntimeWithRecovery
  };
}

export type { ManagedNativeCliProjectMessageSender };

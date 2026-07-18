import type { ExternalAgentConfig } from '@monad/environment';
import type { Event, ManagedExternalAgentLifecycleLogEvent, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ManagedExternalAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { createManagedExternalAgentMessages } from '#/handlers/session/handlers/managed-external-agent-messages.ts';
import { createManagedExternalAgentRuntime } from '#/handlers/session/handlers/managed-external-agent-runtime.ts';
import { managedExternalAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';
import {
  externalAgentInputText,
  managedExternalAgentBusyInboxNotice,
  managedExternalAgentDirectNotice,
  managedExternalAgentInboxNotice,
  normalizeManagedExternalAgentDirectTarget
} from '#/handlers/session/handlers/messaging-notices.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { managedProjectLaunchMode } from '#/services/external-agent/managed-project.ts';

const MANAGED_EXTERNAL_AGENT_DELIVERY_ERROR_EVENT =
  'project.managed_external_agent.delivery_error' satisfies ManagedExternalAgentLifecycleLogEvent;
const MANAGED_EXTERNAL_AGENT_DIRECT_DELIVERY_ERROR_EVENT =
  'project.managed_external_agent.direct_delivery_error' satisfies ManagedExternalAgentLifecycleLogEvent;

export function createManagedExternalAgentDelivery(ctx: SessionContext) {
  const {
    deps: { store, log, externalAgentHost },
    makeEmit,
    persistAndRetire
  } = ctx;

  const { managedExternalAgentSessionsForAgent, startManagedExternalAgentRuntimeWithRecovery } =
    createManagedExternalAgentRuntime(ctx);
  const { emitManagedExternalAgentThinking, completeManagedExternalAgentThinking, retireManagedExternalAgentThinking } =
    createManagedExternalAgentMessages(ctx);

  function recordManagedExternalAgentProjectDeliveryError(
    sessionId: SessionId,
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
    makeEmit(round)(
      makeEvent(sessionId as SessionId, 'agent.error', {
        messageId,
        agentName,
        code: code ?? 'managed_external_agent_delivery_failed',
        message: text
      })
    );
    persistAndRetire(sessionId, round);
  }

  async function deliverProjectMessageToManagedExternalAgentMembers({
    session,
    externalAgents,
    text,
    sender,
    exceptAgentName
  }: {
    session: Session;
    externalAgents: readonly ExternalAgentConfig[];
    text: string;
    sender?: ManagedExternalAgentProjectMessageSender;
    exceptAgentName?: string;
  }): Promise<void> {
    const managedMembers = managedExternalAgentProjectMembers(store, session.id, externalAgents);
    if (managedMembers.length === 0) return;
    const resolvedSender =
      sender?.kind === 'external-agent'
        ? {
            ...sender,
            name:
              managedMembers.find((member) => member.runtimeAgentName === (sender.id ?? sender.name))?.displayName ??
              sender.name
          }
        : sender;
    if (!externalAgentHost || !session.cwd) return;
    for (const member of managedMembers) {
      const { spec, runtimeAgentName, templateAgentName, displayName, configuredDisplayName, settings } = member;
      if (runtimeAgentName === exceptAgentName) continue;
      try {
        const notice = managedExternalAgentInboxNotice(member, text, resolvedSender);
        const deliveredSeq = store.maxMessageSeq(session.id);
        const triggerMessageId =
          deliveredSeq > 0 ? (store.messageIdForSeq(session.id as SessionId, deliveredSeq) ?? undefined) : undefined;
        const deliveryId = deliveredSeq > 0 ? newId('deliv') : undefined;
        const managedSessions = managedExternalAgentSessionsForAgent(session.id, runtimeAgentName);
        const existing = managedSessions.find((candidate) => candidate.state === 'running');
        if (existing) {
          if (deliveredSeq > 0) {
            store.enqueueExternalAgentInboxItem(existing.id, deliveredSeq, {
              deliveryId,
              ...(session.projectId ? { projectId: session.projectId } : {}),
              memberInstanceId: runtimeAgentName,
              triggerMessageId,
              providerSessionRef: existing.providerSessionRef ?? null
            });
          }
          emitManagedExternalAgentThinking(session.id, existing.id, runtimeAgentName, deliveryId, displayName);
          if (existing.launchMode === 'cli-oneshot') {
            // cli-oneshot has no persistent process polling the inbox between turns, so every project
            // message must spawn a fresh turn carrying the message itself — the inbox-poll nudge path
            // (used by persistent members) would silently drop it.
            await externalAgentHost.input(existing.id, { input: externalAgentInputText(notice) });
            if (deliveredSeq > 0) store.markExternalAgentInboxVisible(existing.id, deliveredSeq);
          } else if (existing.lastDeliveredSeq === 0) {
            await externalAgentHost.input(existing.id, { input: externalAgentInputText(notice) });
            if (deliveredSeq > 0) store.markExternalAgentInboxVisible(existing.id, deliveredSeq);
          } else if (existing.lastDeliveredSeq <= existing.lastVisibleSeq) {
            await externalAgentHost.input(existing.id, {
              input: externalAgentInputText(managedExternalAgentBusyInboxNotice(member, resolvedSender))
            });
          }
          store.markExternalAgentInboxDelivered(existing.id, deliveredSeq);
          continue;
        }
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        const resumeFrom = resumeCandidate?.providerSessionRef;
        const preflight = await externalAgentHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          const round: Event[] = [];
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            makeEmit(round)(
              makeEvent(session.id as SessionId, 'external_agent.connection_required', {
                agentName: runtimeAgentName,
                provider: spec.provider,
                code: 'provider_connection_required',
                reason: preflight.reason,
                reconnectIn: 'studio'
              })
            );
            persistAndRetire(session.id, round);
          }
          continue;
        }
        if (resumeCandidate && resumeFrom) store.clearExternalAgentSessionRef(resumeCandidate.id);
        const nativeSession = await startManagedExternalAgentRuntimeWithRecovery({
          session,
          spec,
          runtimeAgentName,
          templateAgentName,
          displayName: configuredDisplayName,
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
          store.enqueueExternalAgentInboxItem(nativeSession.id, deliveredSeq, {
            deliveryId,
            ...(session.projectId ? { projectId: session.projectId } : {}),
            memberInstanceId: runtimeAgentName,
            triggerMessageId,
            providerSessionRef: nativeSession.providerSessionRef ?? null
          });
        }
        store.markExternalAgentInboxDelivered(nativeSession.id, deliveredSeq);
        store.markExternalAgentInboxVisible(nativeSession.id, deliveredSeq);
        emitManagedExternalAgentThinking(session.id, nativeSession.id, runtimeAgentName, deliveryId, displayName);
      } catch (err) {
        const { code, message } = extractError(err);
        recordManagedExternalAgentProjectDeliveryError(session.id, runtimeAgentName, code, message);
        log?.debug(
          {
            sessionId: session.id,
            event: MANAGED_EXTERNAL_AGENT_DELIVERY_ERROR_EVENT,
            agentName: runtimeAgentName,
            code,
            message
          },
          'managed native cli project delivery failed'
        );
      }
    }
  }

  async function deliverDirectMessageToManagedExternalAgentMember({
    session,
    externalAgents,
    fromAgentName,
    to,
    text
  }: {
    session: Session;
    externalAgents: readonly ExternalAgentConfig[];
    fromAgentName: string;
    to: string;
    text: string;
  }): Promise<void> {
    const targetName = normalizeManagedExternalAgentDirectTarget(to);
    if (!targetName || targetName === fromAgentName) return;
    const member = managedExternalAgentProjectMembers(store, session.id, externalAgents).find(
      (candidate) => candidate.runtimeAgentName === targetName
    );
    if (!member) return;
    const { spec, runtimeAgentName, templateAgentName, configuredDisplayName, settings } = member;
    if (!externalAgentHost || !session.cwd) return;
    try {
      const notice = managedExternalAgentDirectNotice({ member, fromAgentName, text });
      const managedSessions = managedExternalAgentSessionsForAgent(session.id, runtimeAgentName);
      const existing = managedSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        await externalAgentHost.input(existing.id, { input: externalAgentInputText(notice) });
        return;
      }
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await externalAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const round: Event[] = [];
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          makeEmit(round)(
            makeEvent(session.id as SessionId, 'external_agent.connection_required', {
              agentName: runtimeAgentName,
              provider: spec.provider,
              code: 'provider_connection_required',
              reason: preflight.reason,
              reconnectIn: 'studio'
            })
          );
          persistAndRetire(session.id, round);
        }
        return;
      }
      if (resumeCandidate && resumeFrom) store.clearExternalAgentSessionRef(resumeCandidate.id);
      await startManagedExternalAgentRuntimeWithRecovery({
        session,
        spec,
        runtimeAgentName,
        templateAgentName,
        displayName: configuredDisplayName,
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
          event: MANAGED_EXTERNAL_AGENT_DIRECT_DELIVERY_ERROR_EVENT,
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
    emitManagedExternalAgentThinking,
    completeManagedExternalAgentThinking,
    retireManagedExternalAgentThinking,
    deliverProjectMessageToManagedExternalAgentMembers,
    deliverDirectMessageToManagedExternalAgentMember,
    managedExternalAgentSessionsForAgent,
    startManagedExternalAgentRuntimeWithRecovery
  };
}

export type { ManagedExternalAgentProjectMessageSender };

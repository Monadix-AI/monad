import type { MeshAgentConfig } from '@monad/environment';
import type { Event, ManagedMeshAgentLifecycleLogEvent, MessageId, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ManagedMeshAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { createManagedMeshAgentMessages } from '#/handlers/session/handlers/managed-mesh-agent-messages.ts';
import { createManagedMeshAgentRuntime } from '#/handlers/session/handlers/managed-mesh-agent-runtime.ts';
import { managedMeshAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';
import {
  managedMeshAgentBusyInboxNotice,
  managedMeshAgentDirectNotice,
  managedMeshAgentInboxNotice,
  meshAgentInputText,
  normalizeManagedMeshAgentDirectTarget
} from '#/handlers/session/handlers/messaging-notices.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { managedProjectLaunchMode } from '#/services/mesh-agent/managed-project.ts';

const MANAGED_MESH_AGENT_DELIVERY_ERROR_EVENT =
  'project.managed_mesh.delivery_error' satisfies ManagedMeshAgentLifecycleLogEvent;
const MANAGED_MESH_AGENT_DIRECT_DELIVERY_ERROR_EVENT =
  'project.managed_mesh.direct_delivery_error' satisfies ManagedMeshAgentLifecycleLogEvent;

export function createManagedMeshAgentDelivery(ctx: SessionContext) {
  const {
    deps: { store, log, meshAgentHost },
    makeEmit,
    persistAndRetire,
    messageIngress
  } = ctx;

  const { managedMeshSessionsForAgent, startManagedMeshAgentRuntimeWithRecovery } = createManagedMeshAgentRuntime(ctx);
  const { emitManagedMeshAgentThinking, completeManagedMeshAgentThinking, retireManagedMeshAgentThinking } =
    createManagedMeshAgentMessages(ctx);

  async function recordManagedMeshAgentProjectDeliveryError(
    sessionId: SessionId,
    agentName: string,
    message: string
  ): Promise<void> {
    const text = `${agentName} failed to process the project message: ${message}`;
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

  async function deliverProjectMessageToManagedMeshAgentMembers({
    session,
    meshAgents,
    text,
    sender,
    triggerMessageId,
    exceptAgentName
  }: {
    session: Session;
    meshAgents: readonly MeshAgentConfig[];
    text: string;
    sender?: ManagedMeshAgentProjectMessageSender;
    triggerMessageId?: MessageId;
    exceptAgentName?: string;
  }): Promise<void> {
    const managedMembers = managedMeshAgentProjectMembers(store, session.id, meshAgents);
    if (managedMembers.length === 0) return;
    const resolvedSender =
      sender?.kind === 'mesh-agent'
        ? {
            ...sender,
            name:
              managedMembers.find((member) => member.runtimeAgentName === (sender.id ?? sender.name))?.displayName ??
              sender.name
          }
        : sender;
    if (!meshAgentHost || !session.cwd) return;
    const deliveredSeq = triggerMessageId
      ? store.messageSeq(session.id, triggerMessageId)
      : store.maxMessageSeq(session.id);
    const resolvedTriggerMessageId =
      triggerMessageId ??
      (deliveredSeq > 0 ? (store.messageIdForSeq(session.id as SessionId, deliveredSeq) ?? undefined) : undefined);
    for (const member of managedMembers) {
      const { spec, runtimeAgentName, templateAgentName, displayName, configuredDisplayName, settings } = member;
      if (runtimeAgentName === exceptAgentName) continue;
      try {
        const notice = managedMeshAgentInboxNotice(member, text, resolvedSender);
        const deliveryId = deliveredSeq > 0 ? newId('deliv') : undefined;
        const managedSessions = managedMeshSessionsForAgent(session.id, runtimeAgentName);
        const existing = managedSessions.find((candidate) => candidate.state === 'running');
        if (existing) {
          const shouldWakeReadableInbox =
            existing.launchMode !== 'cli-oneshot' &&
            existing.lastDeliveredSeq !== 0 &&
            store.countMeshAgentInbox(existing.id) === 0;
          if (deliveredSeq > 0) {
            store.enqueueMeshAgentInboxItem(existing.id, deliveredSeq, {
              deliveryId,
              ...(session.projectId ? { projectId: session.projectId } : {}),
              memberInstanceId: runtimeAgentName,
              triggerMessageId: resolvedTriggerMessageId,
              providerSessionRef: existing.providerSessionRef ?? null
            });
          }
          await emitManagedMeshAgentThinking(session.id, existing.id, runtimeAgentName, deliveryId, displayName);
          if (existing.launchMode === 'cli-oneshot') {
            // cli-oneshot has no persistent process polling the inbox between turns, so every project
            // message must spawn a fresh turn carrying the message itself — the inbox-poll nudge path
            // (used by persistent members) would silently drop it.
            await meshAgentHost.input(existing.id, { input: meshAgentInputText(notice) });
            if (deliveredSeq > 0) store.markMeshAgentInboxVisible(existing.id, deliveredSeq);
          } else if (existing.lastDeliveredSeq === 0) {
            await meshAgentHost.input(existing.id, { input: meshAgentInputText(notice) });
            if (deliveredSeq > 0) store.markMeshAgentInboxVisible(existing.id, deliveredSeq);
          } else if (shouldWakeReadableInbox) {
            await meshAgentHost.input(existing.id, {
              input: meshAgentInputText(managedMeshAgentBusyInboxNotice(member, resolvedSender))
            });
          }
          store.markMeshAgentInboxDelivered(existing.id, deliveredSeq);
          continue;
        }
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        const resumeFrom = resumeCandidate?.providerSessionRef;
        const preflight = await meshAgentHost.preflight(templateAgentName);
        if (preflight.state !== 'ready') {
          const round: Event[] = [];
          if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
            makeEmit(round)(
              makeEvent(session.id as SessionId, 'mesh.connection_required', {
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
        if (resumeCandidate && resumeFrom) store.clearMeshSessionRef(resumeCandidate.id);
        const nativeSession = await startManagedMeshAgentRuntimeWithRecovery({
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
          store.enqueueMeshAgentInboxItem(nativeSession.id, deliveredSeq, {
            deliveryId,
            ...(session.projectId ? { projectId: session.projectId } : {}),
            memberInstanceId: runtimeAgentName,
            triggerMessageId: resolvedTriggerMessageId,
            providerSessionRef: nativeSession.providerSessionRef ?? null
          });
        }
        store.markMeshAgentInboxDelivered(nativeSession.id, deliveredSeq);
        store.markMeshAgentInboxVisible(nativeSession.id, deliveredSeq);
        await emitManagedMeshAgentThinking(session.id, nativeSession.id, runtimeAgentName, deliveryId, displayName);
      } catch (err) {
        const { code, message } = extractError(err);
        await recordManagedMeshAgentProjectDeliveryError(session.id, runtimeAgentName, message);
        log?.debug(
          {
            sessionId: session.id,
            event: MANAGED_MESH_AGENT_DELIVERY_ERROR_EVENT,
            agentName: runtimeAgentName,
            code,
            message
          },
          'managed native cli project delivery failed'
        );
      }
    }
  }

  async function deliverDirectMessageToManagedMeshAgentMember({
    session,
    meshAgents,
    fromAgentName,
    to,
    text
  }: {
    session: Session;
    meshAgents: readonly MeshAgentConfig[];
    fromAgentName: string;
    to: string;
    text: string;
  }): Promise<void> {
    const targetName = normalizeManagedMeshAgentDirectTarget(to);
    if (!targetName || targetName === fromAgentName) return;
    const member = managedMeshAgentProjectMembers(store, session.id, meshAgents).find(
      (candidate) => candidate.runtimeAgentName === targetName
    );
    if (!member) return;
    const { spec, runtimeAgentName, templateAgentName, configuredDisplayName, settings } = member;
    if (!meshAgentHost || !session.cwd) return;
    try {
      const notice = managedMeshAgentDirectNotice({ member, fromAgentName, text });
      const managedSessions = managedMeshSessionsForAgent(session.id, runtimeAgentName);
      const existing = managedSessions.find((candidate) => candidate.state === 'running');
      if (existing) {
        await meshAgentHost.input(existing.id, { input: meshAgentInputText(notice) });
        return;
      }
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await meshAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        const round: Event[] = [];
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          makeEmit(round)(
            makeEvent(session.id as SessionId, 'mesh.connection_required', {
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
      if (resumeCandidate && resumeFrom) store.clearMeshSessionRef(resumeCandidate.id);
      await startManagedMeshAgentRuntimeWithRecovery({
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
          event: MANAGED_MESH_AGENT_DIRECT_DELIVERY_ERROR_EVENT,
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
    emitManagedMeshAgentThinking,
    completeManagedMeshAgentThinking,
    retireManagedMeshAgentThinking,
    deliverProjectMessageToManagedMeshAgentMembers,
    deliverDirectMessageToManagedMeshAgentMember,
    managedMeshSessionsForAgent,
    startManagedMeshAgentRuntimeWithRecovery
  };
}

export type { ManagedMeshAgentProjectMessageSender };

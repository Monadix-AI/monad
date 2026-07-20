import type { MeshAgentConfig } from '@monad/environment';
import type { Event, ManagedMeshAgentLifecycleLogEvent, MessageId, Session, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type {
  ManagedMeshAgentProjectMember,
  UnavailableManagedMeshAgentProjectMember
} from '#/handlers/session/handlers/messaging-members.ts';
import type { ManagedMeshAgentProjectMessageSender } from '#/handlers/session/handlers/messaging-notices.ts';

import { newId } from '@monad/protocol';

import { extractError } from '#/agent/index.ts';
import { createManagedMeshAgentMessages } from '#/handlers/session/handlers/managed-mesh-agent-messages.ts';
import { createManagedMeshAgentRuntime } from '#/handlers/session/handlers/managed-mesh-agent-runtime.ts';
import {
  managedMeshAgentProjectMembers,
  unavailableManagedMeshAgentProjectMembers
} from '#/handlers/session/handlers/messaging-members.ts';
import {
  managedMeshAgentDirectNotice,
  managedMeshAgentInboxNotice,
  meshAgentInputText,
  normalizeManagedMeshAgentDirectTarget
} from '#/handlers/session/handlers/messaging-notices.ts';
import { makeEvent } from '#/services/event-bus.ts';

const MANAGED_MESH_AGENT_DELIVERY_ERROR_EVENT =
  'project.managed_mesh.delivery_error' satisfies ManagedMeshAgentLifecycleLogEvent;
const MANAGED_MESH_AGENT_DIRECT_DELIVERY_ERROR_EVENT =
  'project.managed_mesh.direct_delivery_error' satisfies ManagedMeshAgentLifecycleLogEvent;

function isMeshAgentAuthenticationError(code: string | undefined, message: string): boolean {
  const haystack = `${code ?? ''} ${message}`;
  return /\b(provider_connection_required|not_authenticated|unauthenticated|authentication_failed|unauthorized)\b|not[\s_-]?logged[\s_-]?in|login[\s_-]?required|authentication[\s_-]?required|please run\s+\/login|token[\s_-]?expired/i.test(
    haystack
  );
}

export function createManagedMeshAgentDelivery(ctx: SessionContext) {
  const {
    deps: { store, log, meshAgentHost, bus },
    makeEmit,
    persistAndRetire,
    messageIngress
  } = ctx;

  const { managedMeshSessionsForAgent, startManagedMeshAgentRuntimeWithRecovery } = createManagedMeshAgentRuntime(ctx);
  const { emitManagedMeshAgentThinking, completeManagedMeshAgentThinking, retireManagedMeshAgentThinking } =
    createManagedMeshAgentMessages(ctx);
  const pendingProjectDeliveries = new Map<
    string,
    {
      session: Session;
      meshAgents: readonly MeshAgentConfig[];
      text: string;
      sender?: ManagedMeshAgentProjectMessageSender;
      triggerMessageId?: MessageId;
      agentName: string;
    }
  >();
  const pendingDirectDeliveries = new Map<
    string,
    {
      session: Session;
      meshAgents: readonly MeshAgentConfig[];
      fromAgentName: string;
      to: string;
      text: string;
      agentName: string;
    }
  >();

  bus?.subscribeAll((event) => {
    if (event.type !== 'mesh.login_resolved') return;
    const agentName = typeof event.payload.agentName === 'string' ? event.payload.agentName : undefined;
    if (!agentName) return;
    for (const [key, pending] of [...pendingProjectDeliveries]) {
      if (pending.agentName !== agentName) continue;
      pendingProjectDeliveries.delete(key);
      void deliverProjectMessageToManagedMeshAgentMembers({
        ...pending,
        onlyAgentName: agentName
      });
    }
    for (const [key, pending] of [...pendingDirectDeliveries]) {
      if (pending.agentName !== agentName) continue;
      pendingDirectDeliveries.delete(key);
      void deliverDirectMessageToManagedMeshAgentMember(pending);
    }
  });

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
    exceptAgentName,
    onlyAgentName
  }: {
    session: Session;
    meshAgents: readonly MeshAgentConfig[];
    text: string;
    sender?: ManagedMeshAgentProjectMessageSender;
    triggerMessageId?: MessageId;
    exceptAgentName?: string;
    onlyAgentName?: string;
  }): Promise<void> {
    const managedMembers = managedMeshAgentProjectMembers(store, session.id, meshAgents);
    const unavailableMembers = unavailableManagedMeshAgentProjectMembers(store, session.id, meshAgents);
    const resolvedSender =
      sender?.kind === 'mesh-agent'
        ? {
            ...sender,
            name:
              managedMembers.find((member) => member.runtimeAgentName === (sender.id ?? sender.name))?.displayName ??
              sender.name
          }
        : sender;
    const emitUnavailableConnectionRequired = (member: UnavailableManagedMeshAgentProjectMember) => {
      const round: Event[] = [];
      makeEmit(round)(
        makeEvent(session.id as SessionId, 'mesh.connection_required', {
          agentName: member.runtimeAgentName,
          authAgentName: member.templateAgentName,
          provider: member.provider,
          code: member.code,
          reason: member.reason,
          reconnectIn: 'studio'
        })
      );
      persistAndRetire(session.id, round);
    };
    for (const member of unavailableMembers) {
      if (onlyAgentName && member.runtimeAgentName !== onlyAgentName) continue;
      if (member.runtimeAgentName === exceptAgentName) continue;
      emitUnavailableConnectionRequired(member);
    }
    if (managedMembers.length === 0) return;
    if (!meshAgentHost || !session.cwd) return;
    const deliveredSeq = triggerMessageId
      ? store.messageSeq(session.id, triggerMessageId)
      : store.maxMessageSeq(session.id);
    const resolvedTriggerMessageId =
      triggerMessageId ??
      (deliveredSeq > 0 ? (store.messageIdForSeq(session.id as SessionId, deliveredSeq) ?? undefined) : undefined);
    const retryPending = (member: ManagedMeshAgentProjectMember) => {
      const key = `${session.id}:project:${member.runtimeAgentName}:${resolvedTriggerMessageId ?? deliveredSeq}:${text}`;
      pendingProjectDeliveries.set(key, {
        session,
        meshAgents,
        text,
        ...(resolvedSender ? { sender: resolvedSender } : {}),
        ...(resolvedTriggerMessageId ? { triggerMessageId: resolvedTriggerMessageId } : {}),
        agentName: member.runtimeAgentName
      });
    };
    const emitConnectionRequired = (member: ManagedMeshAgentProjectMember, reason: string) => {
      const round: Event[] = [];
      makeEmit(round)(
        makeEvent(session.id as SessionId, 'mesh.connection_required', {
          agentName: member.runtimeAgentName,
          authAgentName: member.templateAgentName,
          provider: member.spec.provider,
          code: 'provider_connection_required',
          reason,
          reconnectIn: 'studio'
        })
      );
      persistAndRetire(session.id, round);
    };
    const handleDeliveryFailure = async (member: ManagedMeshAgentProjectMember, err: unknown): Promise<void> => {
      const { code, message } = extractError(err);
      if (isMeshAgentAuthenticationError(code, message)) {
        emitConnectionRequired(member, message);
        retryPending(member);
        return;
      }
      try {
        await recordManagedMeshAgentProjectDeliveryError(session.id, member.runtimeAgentName, message);
      } catch (recordError) {
        log?.error(
          {
            sessionId: session.id,
            event: MANAGED_MESH_AGENT_DELIVERY_ERROR_EVENT,
            agentName: member.runtimeAgentName,
            code,
            message,
            recordError: extractError(recordError).message
          },
          'managed native cli project delivery error could not be recorded'
        );
        return;
      }
      log?.debug(
        {
          sessionId: session.id,
          event: MANAGED_MESH_AGENT_DELIVERY_ERROR_EVENT,
          agentName: member.runtimeAgentName,
          code,
          message
        },
        'managed native cli project delivery failed'
      );
    };
    await Promise.all(
      managedMembers.map(async (member) => {
        const { spec, runtimeAgentName, templateAgentName, displayName, configuredDisplayName, settings } = member;
        if (onlyAgentName && runtimeAgentName !== onlyAgentName) return;
        if (runtimeAgentName === exceptAgentName) return;
        try {
          const notice = managedMeshAgentInboxNotice(member, text, resolvedSender);
          const deliveryId = deliveredSeq > 0 ? newId('deliv') : undefined;
          const managedSessions = managedMeshSessionsForAgent(session.id, runtimeAgentName);
          const existing = managedSessions.find((candidate) => candidate.lifecycle.state === 'active');
          if (existing) {
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
            void (async () => {
              try {
                await meshAgentHost.input(existing.id, {
                  input: meshAgentInputText(notice)
                });
                if (deliveredSeq > 0) store.markMeshAgentInboxVisible(existing.id, deliveredSeq);
                store.markMeshAgentInboxDelivered(existing.id, deliveredSeq);
              } catch (err) {
                await handleDeliveryFailure(member, err);
              }
            })();
            return;
          }
          const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
          const resumeFrom = resumeCandidate?.providerSessionRef;
          const preflight = await meshAgentHost.preflight(templateAgentName);
          if (preflight.state !== 'ready') {
            if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
              emitConnectionRequired(member, preflight.reason);
              if (preflight.state === 'not_authenticated') retryPending(member);
            }
            return;
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
          await handleDeliveryFailure(member, err);
        }
      })
    );
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
    if (!member) {
      const unavailable = unavailableManagedMeshAgentProjectMembers(store, session.id, meshAgents).find(
        (candidate) => candidate.runtimeAgentName === targetName
      );
      if (unavailable) {
        const round: Event[] = [];
        makeEmit(round)(
          makeEvent(session.id as SessionId, 'mesh.connection_required', {
            agentName: unavailable.runtimeAgentName,
            authAgentName: unavailable.templateAgentName,
            provider: unavailable.provider,
            code: unavailable.code,
            reason: unavailable.reason,
            reconnectIn: 'studio'
          })
        );
        persistAndRetire(session.id, round);
      }
      return;
    }
    const { spec, runtimeAgentName, templateAgentName, configuredDisplayName, settings } = member;
    if (!meshAgentHost || !session.cwd) return;
    const retryPending = () => {
      pendingDirectDeliveries.set(`${session.id}:direct:${runtimeAgentName}:${fromAgentName}:${text}`, {
        session,
        meshAgents,
        fromAgentName,
        to: runtimeAgentName,
        text,
        agentName: runtimeAgentName
      });
    };
    const emitConnectionRequired = (reason: string) => {
      const round: Event[] = [];
      makeEmit(round)(
        makeEvent(session.id as SessionId, 'mesh.connection_required', {
          agentName: runtimeAgentName,
          authAgentName: templateAgentName,
          provider: spec.provider,
          code: 'provider_connection_required',
          reason,
          reconnectIn: 'studio'
        })
      );
      persistAndRetire(session.id, round);
    };
    try {
      const notice = managedMeshAgentDirectNotice({
        member,
        fromAgentName,
        text
      });
      const managedSessions = managedMeshSessionsForAgent(session.id, runtimeAgentName);
      const existing = managedSessions.find((candidate) => candidate.lifecycle.state === 'active');
      if (existing) {
        await meshAgentHost.input(existing.id, {
          input: meshAgentInputText(notice)
        });
        return;
      }
      const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const preflight = await meshAgentHost.preflight(templateAgentName);
      if (preflight.state !== 'ready') {
        if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
          emitConnectionRequired(preflight.reason);
          if (preflight.state === 'not_authenticated') retryPending();
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
        allowAutopilot: settings.allowAutopilot,
        providerSessionRef: resumeFrom ?? undefined,
        input: notice
      });
    } catch (err) {
      const { code, message } = extractError(err);
      if (isMeshAgentAuthenticationError(code, message)) {
        emitConnectionRequired(message);
        retryPending();
        return;
      }
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

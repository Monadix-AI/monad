import type { MeshAgentConfig } from '@monad/environment';
import type {
  Event,
  ManagedMeshAgentLifecycleLogEvent,
  MessageId,
  NativeAgentDirectMessage,
  Session,
  SessionId
} from '@monad/protocol';
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
  canonicalDirectMembers,
  managedMeshAgentProjectMembers,
  unavailableManagedMeshAgentProjectMembers
} from '#/handlers/session/handlers/messaging-members.ts';
import {
  managedMeshAgentDirectNotice,
  managedMeshAgentInboxNotice,
  meshAgentInputText
} from '#/handlers/session/handlers/messaging-notices.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { enabledInvitableMeshAgentConfigs } from '#/services/mesh-agent/invitable-agents.ts';
import { writeNativeAgentDirectMessageReceipt } from '#/services/native-agent/direct-message-receipt.ts';
import { claimNativeAgentDeliveryBatch } from '#/services/native-agent/ingress-batch.ts';
import { nativeAgentMemberDeliveryCoordinatorFor } from '#/services/native-agent/member-delivery-coordinator.ts';

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

// A durable pending target is woken by a login only when its own canonical member (projectMemberId) is
// bound to the resolved runtime alias in that session. Several members can share one alias, so this must
// test every mesh session for an exact (alias, member) match — never pick the first alias holder.
export function pendingIngressTargetMatchesAlias(
  meshSessions: readonly { agentName: string; projectMemberId?: string | null }[],
  agentName: string,
  targetMemberInstanceId: string
): boolean {
  return meshSessions.some(
    (meshSession) => meshSession.agentName === agentName && meshSession.projectMemberId === targetMemberInstanceId
  );
}

export function createManagedMeshAgentDelivery(ctx: SessionContext) {
  const {
    deps: { store, log, meshAgentHost, bus },
    managedAgentSessions,
    makeEmit,
    persistAndRetire,
    messageIngress
  } = ctx;

  const { managedMeshSessionsForMember, startManagedMeshAgentRuntimeWithRecovery } = createManagedMeshAgentRuntime(ctx);
  const memberDeliveryCoordinator = nativeAgentMemberDeliveryCoordinatorFor(store);
  const { emitManagedMeshAgentThinking, completeManagedMeshAgentThinking, retireManagedMeshAgentThinking } =
    createManagedMeshAgentMessages(ctx);
  async function writeBatchDirectReceipts(batch: ReturnType<typeof claimNativeAgentDeliveryBatch>): Promise<void> {
    for (const item of batch?.items ?? []) {
      if (item.source !== 'direct') continue;
      const message = store.getNativeAgentDirectMessage(item.directMessageId);
      if (message) await writeNativeAgentDirectMessageReceipt({ message, store, messageIngress });
    }
  }
  const pendingProjectDeliveries = new Map<
    string,
    {
      session: Session;
      meshAgents: readonly MeshAgentConfig[];
      text: string;
      sender?: ManagedMeshAgentProjectMessageSender;
      triggerMessageId?: MessageId;
      agentName: string;
      projectMemberId: string;
    }
  >();
  const pendingDirectDeliveries = new Map<
    string,
    {
      session: Session;
      meshAgents: readonly MeshAgentConfig[];
      message: NativeAgentDirectMessage;
      noticeText: string;
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
        onlyProjectMemberId: pending.projectMemberId
      });
    }
    for (const [key, pending] of [...pendingDirectDeliveries]) {
      if (pending.agentName !== agentName) continue;
      pendingDirectDeliveries.delete(key);
      void deliverDirectMessageToManagedMeshAgentMember(pending);
    }
    void redeliverDurablePendingIngress(agentName);
  });

  async function deliverProjectMessageToManagedMeshAgentMembers({
    session,
    meshAgents,
    text,
    sender,
    triggerMessageId,
    exceptProjectMemberId,
    onlyProjectMemberId
  }: {
    session: Session;
    meshAgents: readonly MeshAgentConfig[];
    text: string;
    sender?: ManagedMeshAgentProjectMessageSender;
    triggerMessageId?: MessageId;
    exceptProjectMemberId?: string;
    onlyProjectMemberId?: string;
  }): Promise<void> {
    const managedMembers = managedMeshAgentProjectMembers(store, session.id, meshAgents);
    const unavailableMembers = unavailableManagedMeshAgentProjectMembers(store, session.id, meshAgents);
    const deliveredSeq = triggerMessageId
      ? store.messageSeq(session.id, triggerMessageId)
      : store.maxMessageSeq(session.id);
    const resolvedTriggerMessageId =
      triggerMessageId ??
      (deliveredSeq > 0 ? (store.messageIdForSeq(session.id as SessionId, deliveredSeq) ?? undefined) : undefined);
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
      if (onlyProjectMemberId && member.projectMemberId !== onlyProjectMemberId) continue;
      if (exceptProjectMemberId && member.projectMemberId === exceptProjectMemberId) continue;
      if (session.projectId && deliveredSeq > 0 && resolvedTriggerMessageId) {
        const meshSession = managedMeshSessionsForMember(session.id, member.projectMemberId)[0];
        store.enqueueNativeAgentIngressItem({
          projectId: session.projectId,
          memberInstanceId: member.projectMemberId,
          ...(meshSession ? { meshSessionId: meshSession.id } : {}),
          source: { kind: 'project', messageSeq: deliveredSeq, messageId: resolvedTriggerMessageId }
        });
      }
      emitUnavailableConnectionRequired(member);
    }
    if (managedMembers.length === 0) return;
    if (!meshAgentHost) return;
    const retryPending = (member: ManagedMeshAgentProjectMember) => {
      const key = `${session.id}:project:${member.runtimeAgentName}:${resolvedTriggerMessageId ?? deliveredSeq}:${text}`;
      pendingProjectDeliveries.set(key, {
        session,
        meshAgents,
        text,
        ...(sender ? { sender } : {}),
        ...(resolvedTriggerMessageId ? { triggerMessageId: resolvedTriggerMessageId } : {}),
        agentName: member.runtimeAgentName,
        projectMemberId: member.projectMemberId
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
    const handleDeliveryFailure = async (
      member: ManagedMeshAgentProjectMember,
      err: unknown,
      onAuthenticationFailure?: () => void | Promise<void>
    ): Promise<void> => {
      const { code, message } = extractError(err);
      if (isMeshAgentAuthenticationError(code, message)) {
        await onAuthenticationFailure?.();
        emitConnectionRequired(member, message);
        retryPending(member);
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
        if (onlyProjectMemberId && member.projectMemberId !== onlyProjectMemberId) return;
        if (exceptProjectMemberId && member.projectMemberId === exceptProjectMemberId) return;
        let batch: ReturnType<typeof claimNativeAgentDeliveryBatch> = null;
        try {
          const notice = managedMeshAgentInboxNotice(member, text, sender);
          const deliveryId = deliveredSeq > 0 ? newId('deliv') : undefined;
          const managedSessions = managedMeshSessionsForMember(session.id, member.projectMemberId);
          const existing = managedSessions.find((candidate) => candidate.lifecycle.state === 'active');
          const projectId = session.projectId ?? session.id;
          const isGated = () =>
            Boolean(session.projectId && store.getNativeAgentMemberGate(session.id, member.projectMemberId));
          if (existing) {
            if (deliveredSeq > 0) {
              store.enqueueMeshAgentInboxItem(existing.id, deliveredSeq, {
                deliveryId,
                ...(session.projectId ? { projectId: session.projectId } : {}),
                memberInstanceId: member.projectMemberId,
                triggerMessageId: resolvedTriggerMessageId,
                providerSessionRef: existing.providerSessionRef ?? null
              });
            }
            const supportsBatchClaims = typeof store.claimNativeAgentIngressBatch === 'function';
            batch = supportsBatchClaims
              ? claimNativeAgentDeliveryBatch(store, projectId, session.id, member.projectMemberId)
              : null;
            if (supportsBatchClaims && deliveredSeq > 0 && !batch) return;
            const activeDeliveryId = batch?.id ?? deliveryId;
            if (activeDeliveryId) {
              managedAgentSessions?.queue({
                sessionId: session.id,
                memberId: member.projectMemberId,
                deliveryId: activeDeliveryId
              });
            }
            const admission = await memberDeliveryCoordinator.admitTurn({
              sessionId: session.id,
              memberInstanceId: member.projectMemberId,
              isGated,
              start: async () => {
                if (activeDeliveryId) {
                  managedAgentSessions?.startTurn({
                    sessionId: session.id,
                    memberId: member.projectMemberId,
                    deliveryId: activeDeliveryId,
                    runtimeId: existing.id
                  });
                }
                await emitManagedMeshAgentThinking(
                  session.id,
                  existing.id,
                  member.projectMemberId,
                  activeDeliveryId,
                  displayName
                );
                const completion = meshAgentHost.input(existing.id, {
                  input: meshAgentInputText(batch?.prompt ?? notice)
                });
                try {
                  await completion;
                } catch (error) {
                  batch?.release();
                  throw error;
                }
                batch?.accept();
                await writeBatchDirectReceipts(batch);
                store.markMeshAgentInboxDelivered(existing.id, deliveredSeq);
                if (deliveredSeq > 0) store.markMeshAgentInboxVisible(existing.id, deliveredSeq);
              },
              onSettled: () => {
                if (!activeDeliveryId) return;
                managedAgentSessions?.settleTurn({
                  sessionId: session.id,
                  memberId: member.projectMemberId,
                  deliveryId: activeDeliveryId
                });
              }
            });
            if (!admission.admitted) {
              batch?.release();
              if (activeDeliveryId) {
                managedAgentSessions?.settleTurn({
                  sessionId: session.id,
                  memberId: member.projectMemberId,
                  deliveryId: activeDeliveryId
                });
              }
              if (admission.reason === 'active') {
                await memberDeliveryCoordinator.runWhenIdle(session.id, member.projectMemberId, () =>
                  deliverProjectMessageToManagedMeshAgentMembers({
                    session,
                    meshAgents,
                    text,
                    ...(sender ? { sender } : {}),
                    ...(resolvedTriggerMessageId ? { triggerMessageId: resolvedTriggerMessageId } : {}),
                    onlyProjectMemberId: member.projectMemberId
                  })
                );
              }
              return;
            }
            void admission.completion.catch(async (err) => {
              await handleDeliveryFailure(member, err, async () => {
                await retireManagedMeshAgentThinking(session.id, existing.id, member.projectMemberId);
              });
            });
            return;
          }
          const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
          const resumeFrom = resumeCandidate?.providerSessionRef;
          if (deliveredSeq > 0 && resolvedTriggerMessageId && deliveryId) {
            store.enqueueNativeAgentIngressItem({
              projectId,
              memberInstanceId: member.projectMemberId,
              ...(resumeCandidate ? { meshSessionId: resumeCandidate.id } : {}),
              source: { kind: 'project', messageSeq: deliveredSeq, messageId: resolvedTriggerMessageId },
              deliveryId
            });
          }
          const supportsBatchClaims = typeof store.claimNativeAgentIngressBatch === 'function';
          batch = supportsBatchClaims
            ? claimNativeAgentDeliveryBatch(store, projectId, session.id, member.projectMemberId)
            : null;
          if (supportsBatchClaims && deliveredSeq > 0 && !batch) return;
          const activeDeliveryId = batch?.id ?? deliveryId;
          if (activeDeliveryId) {
            managedAgentSessions?.queue({
              sessionId: session.id,
              memberId: member.projectMemberId,
              deliveryId: activeDeliveryId
            });
          }
          let nativeSession: Awaited<ReturnType<typeof startManagedMeshAgentRuntimeWithRecovery>> | undefined;
          const admission = await memberDeliveryCoordinator.admitTurn({
            sessionId: session.id,
            memberInstanceId: member.projectMemberId,
            isGated,
            start: async () => {
              const preflight = await meshAgentHost.preflight(templateAgentName);
              if (preflight.state !== 'ready') {
                batch?.release();
                if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
                  emitConnectionRequired(member, preflight.reason);
                  if (preflight.state === 'not_authenticated') retryPending(member);
                }
                return;
              }
              if (activeDeliveryId) {
                managedAgentSessions?.startTurn({
                  sessionId: session.id,
                  memberId: member.projectMemberId,
                  deliveryId: activeDeliveryId
                });
              }
              if (resumeCandidate && resumeFrom) store.clearMeshSessionRef(resumeCandidate.id);
              nativeSession = await startManagedMeshAgentRuntimeWithRecovery({
                session,
                spec,
                projectMemberId: member.projectMemberId,
                runtimeAgentName,
                templateAgentName,
                displayName: configuredDisplayName,
                workingDirectoryOverride: settings.cwd,
                reasoningEffort: settings.reasoningEffort,
                modelId: settings.modelId ?? settings.modelName,
                speed: settings.speed,
                customPrompt: settings.customPrompt,
                allowAutopilot: settings.allowAutopilot,
                providerSessionRef: resumeFrom ?? undefined,
                input: batch?.prompt ?? notice,
                reserveInitialTurn: async (meshSessionId) => {
                  await emitManagedMeshAgentThinking(
                    session.id,
                    meshSessionId,
                    member.projectMemberId,
                    activeDeliveryId,
                    displayName
                  );
                },
                rollbackInitialTurn: async (meshSessionId) => {
                  await retireManagedMeshAgentThinking(session.id, meshSessionId, member.projectMemberId, {
                    settleTurn: false
                  });
                }
              });
              batch?.accept();
              await writeBatchDirectReceipts(batch);
              if (activeDeliveryId) {
                store.bindNativeAgentIngressDelivery(
                  activeDeliveryId,
                  nativeSession.id,
                  nativeSession.providerSessionRef
                );
              }
              store.markMeshAgentInboxDelivered(nativeSession.id, deliveredSeq);
              store.markMeshAgentInboxVisible(nativeSession.id, deliveredSeq);
            },
            onSettled: () => {
              if (!activeDeliveryId) return;
              managedAgentSessions?.settleTurn({
                sessionId: session.id,
                memberId: member.projectMemberId,
                deliveryId: activeDeliveryId
              });
            }
          });
          if (!admission.admitted) {
            batch?.release();
            if (activeDeliveryId) {
              managedAgentSessions?.settleTurn({
                sessionId: session.id,
                memberId: member.projectMemberId,
                deliveryId: activeDeliveryId
              });
            }
            if (admission.reason === 'active') {
              await memberDeliveryCoordinator.runWhenIdle(session.id, member.projectMemberId, () =>
                deliverProjectMessageToManagedMeshAgentMembers({
                  session,
                  meshAgents,
                  text,
                  ...(sender ? { sender } : {}),
                  ...(resolvedTriggerMessageId ? { triggerMessageId: resolvedTriggerMessageId } : {}),
                  onlyProjectMemberId: member.projectMemberId
                })
              );
            }
            return;
          }
          await admission.completion;
        } catch (err) {
          batch?.release();
          await handleDeliveryFailure(member, err);
        }
      })
    );
  }

  async function deliverDirectMessageToManagedMeshAgentMember({
    session,
    meshAgents,
    message,
    noticeText
  }: {
    session: Session;
    meshAgents: readonly MeshAgentConfig[];
    message: NativeAgentDirectMessage;
    noticeText: string;
  }): Promise<void> {
    const fromAgentName = message.fromAgent;
    if (!fromAgentName) return;
    // peer is a canonical projectMemberId — match members exactly, never an alias .find that a shared
    // runtime name could make ambiguous. A self-addressed DM (peer === sender) is dropped.
    const peer = message.peer;
    if (!peer || peer === fromAgentName) return;
    // Direct delivery resolves the recipient from the canonical member graph (binding + ProjectMember +
    // provider spec), so a member bound via bindSessionMember is found and a provider-available member is a
    // real startable managed member — not a synthetic connection-required stub.
    const { available: directAvailable, unavailable: directUnavailable } = canonicalDirectMembers(
      store,
      session.id,
      meshAgents
    );
    const member = directAvailable.find((candidate) => candidate.projectMemberId === peer);
    if (!member) {
      const unavailable = directUnavailable.find((candidate) => candidate.projectMemberId === peer);
      if (unavailable) {
        const managedSessions = managedMeshSessionsForMember(session.id, unavailable.projectMemberId);
        const existing = managedSessions.find((candidate) => candidate.lifecycle.state === 'active');
        const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
        if (session.projectId) {
          store.enqueueNativeAgentIngressItem({
            projectId: session.projectId,
            memberInstanceId: unavailable.projectMemberId,
            ...((existing ?? resumeCandidate) ? { meshSessionId: (existing ?? resumeCandidate)?.id } : {}),
            source: { kind: 'direct', directMessageId: message.id },
            createdAt: message.createdAt
          });
        }
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
    const managedSessions = managedMeshSessionsForMember(session.id, member.projectMemberId);
    const existing = managedSessions.find((candidate) => candidate.lifecycle.state === 'active');
    const resumeCandidate = managedSessions.find((candidate) => candidate.providerSessionRef);
    const { spec, runtimeAgentName, templateAgentName, configuredDisplayName, settings } = member;
    if (!meshAgentHost) return;
    const retryPending = () => {
      pendingDirectDeliveries.set(`${session.id}:direct:${message.id}`, {
        session,
        meshAgents,
        message,
        noticeText,
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
    let batch: ReturnType<typeof claimNativeAgentDeliveryBatch> = null;
    let activeDeliveryId: `deliv_${string}` | undefined;
    try {
      const notice = managedMeshAgentDirectNotice({
        member,
        fromAgentName,
        text: noticeText
      });
      const projectId = session.projectId ?? session.id;
      const ingress = store.enqueueNativeAgentIngressItem({
        projectId,
        memberInstanceId: member.projectMemberId,
        ...((existing ?? resumeCandidate) ? { meshSessionId: (existing ?? resumeCandidate)?.id } : {}),
        source: { kind: 'direct', directMessageId: message.id },
        createdAt: message.createdAt
      });
      const supportsBatchClaims = typeof store.claimNativeAgentIngressBatch === 'function';
      batch = supportsBatchClaims
        ? claimNativeAgentDeliveryBatch(store, projectId, session.id, member.projectMemberId)
        : null;
      if (supportsBatchClaims && !batch) return;
      activeDeliveryId = batch?.id ?? ingress.deliveryId;
      managedAgentSessions?.queue({
        sessionId: session.id,
        memberId: member.projectMemberId,
        deliveryId: activeDeliveryId
      });
      const isGated = () =>
        Boolean(session.projectId && store.getNativeAgentMemberGate(session.id, member.projectMemberId));
      const writeReceipts = async () => {
        const directIds = batch?.items
          .filter((item) => item.source === 'direct')
          .map((item) => item.directMessageId) ?? [message.id];
        for (const directMessageId of directIds) {
          const directMessage = store.getNativeAgentDirectMessage(directMessageId);
          if (directMessage) {
            await writeNativeAgentDirectMessageReceipt({ message: directMessage, store, messageIngress });
          }
        }
      };
      if (existing) {
        const admission = await memberDeliveryCoordinator.admitTurn({
          sessionId: session.id,
          memberInstanceId: member.projectMemberId,
          isGated,
          start: async () => {
            managedAgentSessions?.startTurn({
              sessionId: session.id,
              memberId: member.projectMemberId,
              deliveryId: activeDeliveryId as `deliv_${string}`,
              runtimeId: existing.id
            });
            const completion = meshAgentHost.input(existing.id, {
              input: meshAgentInputText(batch?.prompt ?? notice)
            });
            try {
              await completion;
            } catch (error) {
              batch?.release();
              throw error;
            }
            batch?.accept();
            store.bindNativeAgentIngressDelivery(
              activeDeliveryId as `deliv_${string}`,
              existing.id,
              existing.providerSessionRef
            );
            await writeReceipts();
          },
          onSettled: () => {
            managedAgentSessions?.settleTurn({
              sessionId: session.id,
              memberId: member.projectMemberId,
              deliveryId: activeDeliveryId as `deliv_${string}`
            });
          }
        });
        if (!admission.admitted) {
          batch?.release();
          managedAgentSessions?.settleTurn({
            sessionId: session.id,
            memberId: member.projectMemberId,
            deliveryId: activeDeliveryId
          });
          if (admission.reason === 'active') {
            await memberDeliveryCoordinator.runWhenIdle(session.id, member.projectMemberId, () =>
              deliverDirectMessageToManagedMeshAgentMember({ session, meshAgents, message, noticeText })
            );
          }
          return;
        }
        await admission.completion;
        return;
      }
      const resumeFrom = resumeCandidate?.providerSessionRef;
      const admission = await memberDeliveryCoordinator.admitTurn({
        sessionId: session.id,
        memberInstanceId: member.projectMemberId,
        isGated,
        start: async () => {
          const preflight = await meshAgentHost.preflight(templateAgentName);
          if (preflight.state !== 'ready') {
            batch?.release();
            if (preflight.state === 'not_authenticated' || preflight.state === 'unknown') {
              emitConnectionRequired(preflight.reason);
              if (preflight.state === 'not_authenticated') retryPending();
            }
            return;
          }
          managedAgentSessions?.startTurn({
            sessionId: session.id,
            memberId: member.projectMemberId,
            deliveryId: activeDeliveryId as `deliv_${string}`
          });
          if (resumeCandidate && resumeFrom) store.clearMeshSessionRef(resumeCandidate.id);
          const nativeSession = await startManagedMeshAgentRuntimeWithRecovery({
            session,
            spec,
            projectMemberId: member.projectMemberId,
            runtimeAgentName,
            templateAgentName,
            displayName: configuredDisplayName,
            workingDirectoryOverride: settings.cwd,
            reasoningEffort: settings.reasoningEffort,
            modelId: settings.modelId ?? settings.modelName,
            speed: settings.speed,
            customPrompt: settings.customPrompt,
            allowAutopilot: settings.allowAutopilot,
            providerSessionRef: resumeFrom ?? undefined,
            input: batch?.prompt ?? notice
          });
          batch?.accept();
          store.bindNativeAgentIngressDelivery(
            activeDeliveryId as `deliv_${string}`,
            nativeSession.id,
            nativeSession.providerSessionRef
          );
          await writeReceipts();
        },
        onSettled: () => {
          managedAgentSessions?.settleTurn({
            sessionId: session.id,
            memberId: member.projectMemberId,
            deliveryId: activeDeliveryId as `deliv_${string}`
          });
        }
      });
      if (!admission.admitted) {
        batch?.release();
        managedAgentSessions?.settleTurn({
          sessionId: session.id,
          memberId: member.projectMemberId,
          deliveryId: activeDeliveryId
        });
        if (admission.reason === 'active') {
          await memberDeliveryCoordinator.runWhenIdle(session.id, member.projectMemberId, () =>
            deliverDirectMessageToManagedMeshAgentMember({ session, meshAgents, message, noticeText })
          );
        }
        return;
      }
      await admission.completion;
    } catch (err) {
      batch?.release();
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
          to: peer,
          code,
          message
        },
        'managed native cli direct delivery failed'
      );
    }
  }

  async function redeliverDurablePendingIngress(onlyAgentName?: string): Promise<void> {
    if (typeof store.listPendingNativeAgentIngressTargets !== 'function') return;
    const cfg = ctx.deps.configManager?.get().cfg;
    const meshAgents = cfg ? enabledInvitableMeshAgentConfigs(cfg) : [];
    if (meshAgents.length === 0) return;
    // Durable targets are keyed by canonical projectMemberId (c0); the login event only carries the
    // runtime alias, so map it to the member per target session before filtering.
    const targets = store.listPendingNativeAgentIngressTargets().filter((target) => {
      if (!onlyAgentName) return true;
      return pendingIngressTargetMatchesAlias(
        store.listMeshSessionsForTranscriptTarget(target.sessionId as SessionId),
        onlyAgentName,
        target.memberInstanceId
      );
    });
    for (const target of targets) {
      const session = store.getSession(target.sessionId);
      if (!session) continue;
      if (target.source.kind === 'project') {
        const message = store.getMessage(target.sessionId, target.source.messageId as MessageId);
        if (!message) continue;
        await deliverProjectMessageToManagedMeshAgentMembers({
          session,
          meshAgents,
          text: message.text,
          triggerMessageId: target.source.messageId as MessageId,
          onlyProjectMemberId: target.memberInstanceId
        });
        continue;
      }
      const message = store.getNativeAgentDirectMessage(target.source.directMessageId);
      if (!message) continue;
      await deliverDirectMessageToManagedMeshAgentMember({
        session,
        meshAgents,
        message,
        noticeText: message.text
      });
    }
  }

  queueMicrotask(() => {
    void redeliverDurablePendingIngress().catch((error) => {
      log?.debug({ error: extractError(error).message }, 'managed native cli pending ingress reconciliation failed');
    });
  });

  return {
    emitManagedMeshAgentThinking,
    completeManagedMeshAgentThinking,
    retireManagedMeshAgentThinking,
    deliverProjectMessageToManagedMeshAgentMembers,
    deliverDirectMessageToManagedMeshAgentMember,
    managedMeshSessionsForMember,
    startManagedMeshAgentRuntimeWithRecovery
  };
}

export type { ManagedMeshAgentProjectMessageSender };

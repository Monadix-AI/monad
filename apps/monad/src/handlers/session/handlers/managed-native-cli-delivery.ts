import type { NativeCliAgentConfig } from '@monad/home';
import type {
  Event,
  ManagedNativeCliLifecycleLogEvent,
  MessageAttachmentRef,
  MessageId,
  TranscriptTarget,
  TranscriptTargetId
} from '@monad/protocol';
import type { SessionContext } from '@/handlers/session/context.ts';
import type { ManagedNativeCliProjectMessageSender } from '@/handlers/session/handlers/messaging-notices.ts';

import { newId } from '@monad/protocol';

import { extractError } from '@/agent/index.ts';
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

/** Delivery of Workplace Project messages (fan-out + direct) to managed native-CLI project members,
 *  plus the "thinking" placeholder lifecycle that mirrors their streamed replies into the transcript.
 *  Stateful: owns `pendingManagedNativeCliWakeMessages`, shared across every function here. Process
 *  start/resume itself lives in managed-native-cli-runtime.ts. */
export function createManagedNativeCliDelivery(ctx: SessionContext) {
  const {
    deps: { store, log, nativeCliHost },
    makeEmit,
    persistAndRetire
  } = ctx;

  const { managedNativeCliSessionsForAgent, startManagedNativeCliRuntimeWithRecovery } =
    createManagedNativeCliRuntime(ctx);

  const pendingManagedNativeCliWakeMessages = new Map<string, MessageId>();

  function emitManagedNativeCliThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string
  ): MessageId {
    const existing =
      pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ??
      store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    if (existing) return existing as MessageId;
    const messageId = newId('msg');
    // Entries are deleted on completion, but a native CLI session that dies mid-turn never
    // completes; cap the map so abandoned wake placeholders can't accumulate for the daemon's
    // lifetime (oldest-first eviction — Map preserves insertion order).
    if (pendingManagedNativeCliWakeMessages.size >= 256) {
      const oldest = pendingManagedNativeCliWakeMessages.keys().next().value;
      if (oldest !== undefined) pendingManagedNativeCliWakeMessages.delete(oldest);
    }
    pendingManagedNativeCliWakeMessages.set(nativeCliSessionId, messageId);
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
    return messageId;
  }

  function completeManagedNativeCliThinking({
    sessionId,
    nativeCliSessionId,
    agentName,
    text,
    threadId,
    attachments,
    source = 'managed-native-cli',
    error = false
  }: {
    sessionId: TranscriptTargetId;
    nativeCliSessionId: string;
    agentName: string;
    text: string;
    threadId?: string;
    attachments?: MessageAttachmentRef[];
    source?: 'managed-native-cli' | 'native-cli-provider';
    error?: boolean;
  }): { messageId: MessageId } {
    const pendingMessageId =
      pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ??
      store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    pendingManagedNativeCliWakeMessages.delete(nativeCliSessionId);
    const messageId = (pendingMessageId ?? newId('msg')) as MessageId;
    const data = {
      agentName,
      nativeCliSessionId,
      source,
      ...(threadId ? { threadId } : {}),
      ...(attachments?.length ? { attachments } : {})
    };
    // Post order is the wall order, and created_at is millisecond-resolution: two replies settling
    // in the same tick would tie and fall back to placeholder (fan-out) order. Keep the completion
    // stamp strictly monotonic per session so a later post always sorts after an earlier one.
    const floor = store.maxMessageCreatedAt(sessionId);
    const now = new Date().toISOString();
    const completedAt = floor && floor >= now ? new Date(Date.parse(floor) + 1).toISOString() : now;
    const completed = store.setGenStatus(sessionId, messageId, 'complete', completedAt, {
      data,
      ...(error ? { type: 'error' as const } : {}),
      includeInContext: true,
      text,
      // Re-stamp created_at to the post time so the wall orders by when this agent replied, not when
      // its "thinking" placeholder was reserved at fan-out (see setGenStatus). The live projection
      // already anchors these to the completion event; this keeps the reloaded order identical.
      createdAt: completedAt
    });
    if (!completed && !store.getMessage(sessionId, messageId)) {
      store.insertMessage(messageId, sessionId, text, completedAt, 'assistant', {
        ...(error ? { type: 'error' as const } : {}),
        data
      });
    }
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text, source, ...(attachments?.length ? { attachments } : {}) },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return { messageId };
  }

  function retireManagedNativeCliThinking(
    sessionId: TranscriptTargetId,
    nativeCliSessionId: string,
    agentName: string
  ): MessageId | null {
    const pendingMessageId =
      pendingManagedNativeCliWakeMessages.get(nativeCliSessionId) ??
      store.findManagedNativeCliStreamingMessage(sessionId, nativeCliSessionId, agentName);
    pendingManagedNativeCliWakeMessages.delete(nativeCliSessionId);
    if (!pendingMessageId) return null;
    const retired = store.retireManagedNativeCliStreamingMessage(
      sessionId,
      pendingMessageId,
      nativeCliSessionId,
      agentName
    );
    if (!retired) return null;
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: {
        messageId: pendingMessageId,
        agentName,
        text: '{"visibility":"silent","display":{"kind":"markdown","content":""},"attachments":[],"next":[]}',
        source: 'managed-native-cli'
      },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return pendingMessageId as MessageId;
  }

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
        const managedSessions = managedNativeCliSessionsForAgent(session.id, runtimeAgentName);
        const existing = managedSessions.find((candidate) => candidate.state === 'running');
        if (existing) {
          if (deliveredSeq > 0) store.enqueueNativeCliInboxItem(existing.id, deliveredSeq);
          emitManagedNativeCliThinking(session.id, existing.id, runtimeAgentName);
          if (existing.lastDeliveredSeq === 0) {
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
          providerSessionRef: resumeFrom ?? undefined,
          input: notice
        });
        if (deliveredSeq > 0) store.enqueueNativeCliInboxItem(nativeSession.id, deliveredSeq);
        store.markNativeCliInboxDelivered(nativeSession.id, deliveredSeq);
        store.markNativeCliInboxVisible(nativeSession.id, deliveredSeq);
        emitManagedNativeCliThinking(session.id, nativeSession.id, runtimeAgentName);
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
      const notice = managedNativeCliDirectNotice({ fromAgentName, text });
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

  function beginProjectQaWallMessage({
    sessionId,
    agentName,
    text
  }: {
    sessionId: TranscriptTargetId;
    agentName: string;
    text: string;
  }): { messageId: MessageId } {
    const messageId = newId('msg');
    store.insertMessage(messageId, sessionId, text, new Date().toISOString(), 'assistant', {
      data: { agentName, kind: 'project-qa' },
      includeInContext: false,
      streamStatus: 'streaming'
    });
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
    return { messageId };
  }

  function completeProjectQaWallMessage({
    sessionId,
    messageId,
    agentName,
    text
  }: {
    sessionId: TranscriptTargetId;
    messageId: MessageId;
    agentName: string;
    text: string;
  }): void {
    store.setGenStatus(sessionId, messageId, 'complete', new Date().toISOString(), { text });
    const round: Event[] = [];
    makeEmit(round)({
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type: 'agent.message',
      actorAgentId: null,
      payload: { messageId, agentName, text },
      at: new Date().toISOString()
    });
    persistAndRetire(sessionId, round);
  }

  return {
    emitManagedNativeCliThinking,
    completeManagedNativeCliThinking,
    retireManagedNativeCliThinking,
    deliverProjectMessageToManagedNativeCliMembers,
    deliverDirectMessageToManagedNativeCliMember,
    managedNativeCliSessionsForAgent,
    startManagedNativeCliRuntimeWithRecovery,
    beginProjectQaWallMessage,
    completeProjectQaWallMessage
  };
}

export type { ManagedNativeCliProjectMessageSender };

import type { Store } from '#/store/db/index.ts';
import type { NativeAgentMemberDeliveryCoordinator } from './member-delivery-coordinator.ts';

import { definePrompt } from '#/agent/prompt-template.ts';
import projectAskRecoveryPath from './prompts/project-ask-recovery-user.prompt.md' with { type: 'file' };

const PROJECT_ASK_RECOVERY_PROMPT = await definePrompt<{
  batchJson: string;
}>({ id: 'native-agent.project-ask-recovery.user', sourcePath: projectAskRecoveryPath });

interface NativeAgentProjectAskRecoveryDeps {
  store: Store;
  coordinator: NativeAgentMemberDeliveryCoordinator;
  input: (meshSessionId: string, prompt: string, onAccepted: () => void) => Promise<void>;
  writeDirectReceipt: (directMessageId: string) => Promise<void>;
}

function readableAnswer(answer: string | string[] | undefined): string {
  if (answer === undefined) return '(skipped)';
  return Array.isArray(answer) ? answer.join(', ') : answer;
}

export function createNativeAgentProjectAskRecovery(deps: NativeAgentProjectAskRecoveryDeps) {
  const recover = async (requestId: string, includeOutcome: boolean): Promise<void> => {
    const ask = deps.store.getNativeAgentAsk(requestId);
    if (!ask?.outcome || !ask.meshSessionId) return;
    const gate = deps.store.getNativeAgentMemberGate(ask.projectSessionId, ask.memberInstanceId);
    if (!gate || (gate.state !== 'releasing' && gate.state !== 'recovering')) return;
    if (gate.state === 'releasing') {
      const transitioned = deps.store.transitionNativeAgentMemberGate(requestId, 'releasing', 'recovering');
      if (!transitioned) return;
    }

    const batch = deps.store.claimNextNativeAgentIngressBatch({
      projectId: ask.projectId,
      sessionId: ask.projectSessionId,
      memberInstanceId: ask.memberInstanceId,
      askRequestId: requestId
    });
    const items = deps.store.listClaimedNativeAgentIngress(batch.id);
    if (!includeOutcome && items.length === 0) {
      deps.store.consumeNativeAgentIngressBatch(batch.id);
      if (!deps.store.finishNativeAgentAskRecovery(requestId)) await recover(requestId, false);
      return;
    }
    if (batch.state !== 'delivered') {
      let accepted = false;
      let acceptedError: unknown;
      const prompt = PROJECT_ASK_RECOVERY_PROMPT.render({
        batchJson: JSON.stringify({
          batchId: batch.id,
          ...(includeOutcome
            ? {
                ask: {
                  requestId: ask.requestId,
                  outcome: ask.outcome,
                  resolvedAt: ask.resolvedAt ?? ask.updatedAt
                },
                questions: ask.questions.map((question) => ({
                  id: question.id,
                  question: question.question,
                  answer: readableAnswer(ask.answers?.[question.id])
                }))
              }
            : {}),
          messages: items
        })
      });
      const admission = await deps.coordinator.admitTurn({
        sessionId: ask.projectSessionId,
        memberInstanceId: ask.memberInstanceId,
        isGated: () => false,
        start: () =>
          deps.input(ask.meshSessionId as string, prompt, () => {
            accepted = true;
            deps.store.markNativeAgentIngressBatchDelivered(batch.id);
            deps.store.consumeNativeAgentIngressBatch(batch.id);
          })
      });
      if (!admission.admitted) {
        if (admission.reason === 'active') {
          await deps.coordinator.runWhenIdle(ask.projectSessionId, ask.memberInstanceId, () =>
            recover(requestId, includeOutcome)
          );
        }
        return;
      }
      try {
        await admission.completion;
      } catch (error) {
        if (!accepted) {
          deps.store.releaseNativeAgentIngressBatch(batch.id);
          deps.store.transitionNativeAgentMemberGate(requestId, 'recovering', 'releasing');
          throw error;
        }
        acceptedError = error;
      }
      if (acceptedError !== undefined) {
        for (const item of items) {
          if (item.source === 'direct') await deps.writeDirectReceipt(item.directMessageId);
        }
        deps.store.consumeNativeAgentIngressBatch(batch.id);
        if (!deps.store.finishNativeAgentAskRecovery(requestId)) await recover(requestId, false);
        throw acceptedError;
      }
    }
    for (const item of items) {
      if (item.source === 'direct') await deps.writeDirectReceipt(item.directMessageId);
    }
    deps.store.consumeNativeAgentIngressBatch(batch.id);
    if (!deps.store.finishNativeAgentAskRecovery(requestId)) await recover(requestId, false);
  };

  return {
    async schedule(requestId: string, options: { includeOutcome: boolean }): Promise<void> {
      const ask = deps.store.getNativeAgentAsk(requestId);
      if (!ask) return;
      await deps.coordinator.runWhenIdle(ask.projectSessionId, ask.memberInstanceId, () =>
        recover(requestId, options.includeOutcome)
      );
    }
  };
}

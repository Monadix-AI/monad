import type { NativeAgentDeliveryId } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

import { newId } from '@monad/protocol';

import { definePrompt } from '#/agent/prompt-template.ts';
import memberIngressBatchPath from './prompts/member-ingress-batch-user.prompt.md' with { type: 'file' };

const MEMBER_INGRESS_BATCH_PROMPT = await definePrompt<{ batchJson: string }>({
  id: 'native-agent.member-ingress-batch.user',
  sourcePath: memberIngressBatchPath
});

export function claimNativeAgentDeliveryBatch(
  store: Store,
  projectId: string,
  sessionId: string,
  memberInstanceId: string
) {
  const id = newId('deliv') as NativeAgentDeliveryId;
  const batch = store.claimNativeAgentIngressBatch({ id, projectId, sessionId, memberInstanceId });
  const items = store.listClaimedNativeAgentIngress(batch.id);
  if (items.length === 0) {
    store.releaseNativeAgentIngressBatch(batch.id);
    return null;
  }
  let finished = false;
  return {
    id,
    items,
    prompt: MEMBER_INGRESS_BATCH_PROMPT.render({
      batchJson: JSON.stringify({ batchId: id, messages: items })
    }),
    accept(): void {
      if (finished) return;
      finished = true;
      store.markNativeAgentIngressBatchDelivered(batch.id);
      store.consumeNativeAgentIngressBatch(batch.id);
    },
    release(): void {
      if (finished) return;
      finished = true;
      store.releaseNativeAgentIngressBatch(batch.id);
    }
  };
}

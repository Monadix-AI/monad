import type { MonadConfig, MonadPaths } from '@monad/home';
import type { Event, TranscriptTargetId } from '@monad/protocol';
import type { EventBus } from '@/services/event-bus.ts';
import type { Store } from '@/store/db/index.ts';

import { newId } from '@monad/protocol';

import { buildOperatorRules, PolicyEngine } from '@/agent/approvals/engine.ts';
import { ApprovalStore } from '@/agent/approvals/store.ts';
import { ClarifyService } from '@/services/generation/clarify.ts';
import { OversightService } from '@/services/oversight.ts';

export async function createInterruptServices(deps: {
  paths: MonadPaths;
  cfg: MonadConfig;
  store: Store;
  bus: EventBus;
}): Promise<{
  oversight: OversightService;
  clarify: ClarifyService;
  reloadApprovalPolicy: (approvals: MonadConfig['agent']['approvals']) => void;
}> {
  const { paths, cfg, store, bus } = deps;
  const approvalStore = await ApprovalStore.load(paths.approvals);
  let operatorRules = buildOperatorRules(cfg.agent.approvals);
  const policyEngine = new PolicyEngine(approvalStore, () => operatorRules);

  const oversight = new OversightService({
    publish: (event) => {
      store.appendEvents([event]);
      bus.publish(event);
    },
    engine: policyEngine,
    originOf: (id) => store.getSession(id)?.agentIds[0] ?? null
  });

  const danglingTombstones = store.findDanglingInterrupts().flatMap((d): Event[] => {
    const now = new Date().toISOString();
    if (d.type === 'approval') {
      if (!d.tool) return [];
      return [
        {
          id: newId('evt'),
          transcriptTargetId: d.sessionId as TranscriptTargetId,
          type: 'tool.approval_resolved' as const,
          actorAgentId: null,
          payload: { requestId: d.requestId, tool: d.tool, allow: false, reason: 'daemon_restarted' },
          at: now
        }
      ];
    }
    return [
      {
        id: newId('evt'),
        transcriptTargetId: d.sessionId as TranscriptTargetId,
        type: 'clarify.resolved' as const,
        actorAgentId: null,
        payload: { requestId: d.requestId, answer: '', reason: 'daemon_restarted' },
        at: now
      }
    ];
  });
  if (danglingTombstones.length > 0) {
    store.appendEvents(danglingTombstones);
    for (const t of danglingTombstones) bus.publish(t);
  }

  const clarify = new ClarifyService({
    publish: (event) => {
      store.appendEvents([event]);
      bus.publish(event);
    }
  });

  return {
    oversight,
    clarify,
    reloadApprovalPolicy: (approvals) => {
      operatorRules = buildOperatorRules(approvals);
    }
  };
}

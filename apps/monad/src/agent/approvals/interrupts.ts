import type { MonadConfig, MonadPaths } from '@monad/environment';
import type { Event, SessionId } from '@monad/protocol';
import type { EventBus } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';

import { buildOperatorRules, PolicyEngine } from '#/agent/approvals/engine.ts';
import { ApprovalStore } from '#/agent/approvals/store.ts';
import { makeEvent } from '#/services/event-bus.ts';
import { ClarifyService } from '#/services/generation/clarify.ts';
import { OversightService } from '#/services/oversight.ts';

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

  const danglingInterrupts = store.findDanglingInterrupts();
  const danglingTombstones = danglingInterrupts.flatMap((d): Event[] => {
    const now = new Date().toISOString();
    if (d.type !== 'approval' || !d.tool) return [];
    return [
      makeEvent(
        d.sessionId as SessionId,
        'tool.approval_resolved',
        { requestId: d.requestId, tool: d.tool, allow: false, reason: 'daemon_restarted' },
        { at: now }
      )
    ];
  });
  if (danglingTombstones.length > 0) {
    store.appendEvents(danglingTombstones);
    for (const t of danglingTombstones) bus.publish(t);
  }

  const restoredClarifications = danglingInterrupts.flatMap((dangling) => {
    if (dangling.type !== 'clarify') return [];
    return store
      .listEvents(dangling.sessionId)
      .filter(
        (event) =>
          event.type === 'clarify.requested' &&
          (event.payload as { requestId?: string }).requestId === dangling.requestId
      )
      .slice(-1);
  });

  const clarify = new ClarifyService({
    publish: (event) => {
      store.appendEvents([event]);
      bus.publish(event);
    },
    lookupTerminal: (requestId) => store.getClarificationResolution(requestId),
    restore: restoredClarifications
  });

  return {
    oversight,
    clarify,
    reloadApprovalPolicy: (approvals) => {
      operatorRules = buildOperatorRules(approvals);
    }
  };
}

import type { EventBus } from '#/services/event-bus.ts';
import type { Store } from '#/store/db/index.ts';

import { drainPendingSessionPlanEvents } from '#/handlers/session/handlers/session-plan.ts';

export interface SessionPlanBootReconcileResult {
  drained: number;
}

/**
 * The one boot-time reconciliation step for the durable SessionPlan outbox — the symbol
 * `startDaemon` calls, and the same symbol integration tests call, so a test proves the
 * production call site's behavior rather than a parallel stand-in. Must run after
 * `bindSessionGateway` so a subscriber is live before anything is republished.
 */
export function reconcileSessionPlanOutboxAtBoot(store: Store, bus: EventBus): SessionPlanBootReconcileResult {
  return { drained: drainPendingSessionPlanEvents(store, bus) };
}

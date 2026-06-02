import type {
  ExperienceWorker,
  ProjectExperienceEvent,
  WorkplaceExperienceApiContext,
  WorkplaceExperiencePermission
} from '@monad/sdk-atom';
import type { Store } from '#/store/db/index.ts';

interface Registration {
  atomPackId: string;
  permissions: readonly WorkplaceExperiencePermission[];
  worker: ExperienceWorker;
}

export class ExperienceWorkerRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private admitting = true;

  constructor(
    private readonly deps: {
      store: Store;
      contextFor: (
        atomPackId: string,
        permissions: readonly WorkplaceExperiencePermission[],
        experienceId: string
      ) => WorkplaceExperienceApiContext;
    }
  ) {}

  register(atomPackId: string, permissions: readonly WorkplaceExperiencePermission[], worker: ExperienceWorker): void {
    if (!permissions.includes('experience.worker')) {
      throw new Error('workplace experience permission required: experience.worker');
    }
    const key = `${atomPackId}:${worker.experienceId}`;
    if (this.registrations.has(key)) throw new Error(`duplicate experience worker: ${key}`);
    this.registrations.set(key, { atomPackId, permissions, worker });
  }

  clear(): void {
    this.registrations.clear();
  }

  /**
   * Stop admitting work, wait for the in-flight deliveries to settle, then drop the registrations.
   *
   * A bare `clear()` leaves whatever `publish` already handed to a worker running against a pack
   * that is being replaced or uninstalled. Draining first means the swap observes a quiet registry:
   * new events are dropped from the moment admission closes, and the deliveries already queued get
   * to finish against the pack that accepted them.
   */
  async drain(): Promise<void> {
    this.admitting = false;
    // Deliveries chain per session, so awaiting the current tail awaits everything queued behind it.
    // Re-read after settling: a delivery admitted just before the flag flipped can extend its chain.
    while (this.eventQueues.size > 0) {
      await Promise.allSettled([...this.eventQueues.values()]);
    }
    this.registrations.clear();
  }

  /** Reopen admission after a drained registry has been repopulated. */
  resume(): void {
    this.admitting = true;
  }

  async startProjects(projectIds: readonly string[]): Promise<void> {
    for (const registration of this.registrations.values()) {
      const context = this.context(registration);
      for (const projectId of projectIds) await registration.worker.onProjectStart(projectId, context);
    }
  }

  async publish(event: ProjectExperienceEvent): Promise<void> {
    if (!this.admitting) return;
    const previous = this.eventQueues.get(event.sessionId) ?? Promise.resolve();
    const delivery = previous.catch(() => {}).then(() => this.deliver(event));
    this.eventQueues.set(event.sessionId, delivery);
    void delivery.then(
      () => this.clearEventQueue(event.sessionId, delivery),
      () => this.clearEventQueue(event.sessionId, delivery)
    );
    return delivery;
  }

  private async deliver(event: ProjectExperienceEvent): Promise<void> {
    for (const registration of this.registrations.values()) {
      if (!registration.worker.subscriptions.includes(event.type)) continue;
      await registration.worker.onEvent(event, this.context(registration));
    }
  }

  private clearEventQueue(sessionId: string, delivery: Promise<void>): void {
    if (this.eventQueues.get(sessionId) === delivery) this.eventQueues.delete(sessionId);
  }

  async deliverDueWakeups(now = new Date().toISOString()): Promise<void> {
    for (const wakeup of this.deps.store.listDueExperienceWorkerWakeups(now)) {
      const registration = [...this.registrations.values()].find(
        (candidate) =>
          candidate.atomPackId === wakeup.atomPackId && candidate.worker.experienceId === wakeup.experienceId
      );
      if (!registration) continue;
      const context = this.context(registration);
      try {
        await registration.worker.onWake({ projectId: wakeup.projectId, key: wakeup.key, now }, context);
        await context.workerScheduler.cancel(wakeup.projectId, wakeup.key);
      } catch {
        const retryAt = new Date(new Date(now).getTime() + 60_000).toISOString();
        await context.workerScheduler.schedule(wakeup.projectId, { key: wakeup.key, runAt: retryAt });
      }
    }
  }

  private context(registration: Registration): WorkplaceExperienceApiContext {
    return this.deps.contextFor(registration.atomPackId, registration.permissions, registration.worker.experienceId);
  }
}

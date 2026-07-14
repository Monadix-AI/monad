import type {
  ExperienceWorker,
  ProjectExperienceEvent,
  WorkspaceExperienceApiContext,
  WorkspaceExperiencePermission
} from '@monad/sdk-atom';
import type { Store } from '#/store/db/index.ts';

interface Registration {
  atomPackId: string;
  principalId: string;
  permissions: readonly WorkspaceExperiencePermission[];
  worker: ExperienceWorker;
}

export class ExperienceWorkerRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly eventQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      store: Store;
      contextFor: (
        atomPackId: string,
        principalId: string,
        permissions: readonly WorkspaceExperiencePermission[],
        experienceId: string
      ) => WorkspaceExperienceApiContext;
    }
  ) {}

  register(
    atomPackId: string,
    principalId: string,
    permissions: readonly WorkspaceExperiencePermission[],
    worker: ExperienceWorker
  ): void {
    if (!permissions.includes('experience.worker')) {
      throw new Error('workspace Experience permission required: experience.worker');
    }
    const key = `${atomPackId}:${principalId}:${worker.experienceId}`;
    if (this.registrations.has(key)) throw new Error(`duplicate experience worker: ${key}`);
    this.registrations.set(key, { atomPackId, principalId, permissions, worker });
  }

  clear(): void {
    this.registrations.clear();
  }

  async startProjects(projectIds: readonly string[]): Promise<void> {
    for (const registration of this.registrations.values()) {
      const context = this.context(registration);
      for (const projectId of projectIds) await registration.worker.onProjectStart(projectId, context);
    }
  }

  async publish(event: ProjectExperienceEvent): Promise<void> {
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
          candidate.atomPackId === wakeup.atomPackId &&
          candidate.principalId === wakeup.principalId &&
          candidate.worker.experienceId === wakeup.experienceId
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

  private context(registration: Registration): WorkspaceExperienceApiContext {
    return this.deps.contextFor(
      registration.atomPackId,
      registration.principalId,
      registration.permissions,
      registration.worker.experienceId
    );
  }
}

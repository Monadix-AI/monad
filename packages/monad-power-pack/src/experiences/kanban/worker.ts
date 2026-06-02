import type { ExperienceWorker } from '@monad/sdk-atom';

import { KanbanStore } from './store.ts';
export const kanbanWorker: ExperienceWorker = {
  experienceId: 'kanban',
  subscriptions: ['session.deleted'],
  async onProjectStart(projectId, context) {
    const store = new KanbanStore(context);
    await store.recoverProvisioning(projectId);
    await store.reconcileTasks(projectId, await context.projectSessions.list(projectId));
  },
  async onWake() {},
  async onEvent(event, context) {
    if (event.type !== 'session.deleted') return;
    await new KanbanStore(context).removeTasksForSession(event.projectId, event.sessionId);
  }
};

import type { Database } from 'bun:sqlite';
import type { ReorderWorkplaceProjectRequest, ReorderWorkplaceProjectResponse } from '@monad/protocol';

export class ProjectOrderConflictError extends Error {
  constructor() {
    super('Project order changed; refresh and retry');
  }
}

export function getWorkplaceProjectOrderRevision(sqlite: Database): number {
  return (
    (sqlite.query('SELECT revision FROM workplace_project_order WHERE id = 1').get() as { revision: number } | null)
      ?.revision ?? 0
  );
}

export function reorderWorkplaceProject(
  sqlite: Database,
  input: ReorderWorkplaceProjectRequest
): ReorderWorkplaceProjectResponse {
  const reorder = sqlite.transaction((request: ReorderWorkplaceProjectRequest) => {
    const revision = getWorkplaceProjectOrderRevision(sqlite);
    if (revision !== request.expectedRevision) throw new ProjectOrderConflictError();
    const ids = (
      sqlite.query('SELECT id FROM workplace_projects ORDER BY sort_rank ASC, id ASC').all() as Array<{ id: string }>
    ).map((row) => row.id);
    const sourceIndex = ids.indexOf(request.projectId);
    if (sourceIndex < 0) throw new Error(`Workplace project not found: ${request.projectId}`);
    ids.splice(sourceIndex, 1);
    const neighborId = request.beforeProjectId ?? request.afterProjectId;
    const neighborIndex = neighborId === undefined ? -1 : ids.indexOf(neighborId);
    if (neighborIndex < 0) throw new Error(`Workplace project not found: ${neighborId}`);
    ids.splice(request.beforeProjectId === undefined ? neighborIndex + 1 : neighborIndex, 0, request.projectId);
    const update = sqlite.query('UPDATE workplace_projects SET sort_rank = ? WHERE id = ?');
    for (const [rank, id] of ids.entries()) update.run(rank, id);
    const orderRevision = revision + 1;
    sqlite.query('UPDATE workplace_project_order SET revision = ? WHERE id = 1').run(orderRevision);
    return { projectId: request.projectId, orderRevision };
  });
  return reorder(input);
}

export type ProjectOrderDestination = { beforeProjectId: string } | { afterProjectId: string };

const PROJECT_DRAG_TYPE = 'application/x-monad-project-id';

type ProjectDragDataTransfer = Pick<DataTransfer, 'getData' | 'setData'>;

export type ProjectDropBreakpoint = { beforeProjectId: string | null; y: number };

export function closestProjectDropBreakpoint(
  breakpoints: readonly ProjectDropBreakpoint[],
  pointerY: number
): string | null | undefined {
  let closest: ProjectDropBreakpoint | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const breakpoint of breakpoints) {
    const nextDistance = Math.abs(pointerY - breakpoint.y);
    if (nextDistance >= distance) continue;
    closest = breakpoint;
    distance = nextDistance;
  }
  return closest?.beforeProjectId;
}

export function writeProjectDragId(dataTransfer: ProjectDragDataTransfer, projectId: string): void {
  dataTransfer.setData(PROJECT_DRAG_TYPE, projectId);
  dataTransfer.setData('text/plain', projectId);
}

export function readProjectDragId(dataTransfer: Pick<ProjectDragDataTransfer, 'getData'>): string | null {
  const projectId = dataTransfer.getData(PROJECT_DRAG_TYPE) || dataTransfer.getData('text/plain');
  return projectId || null;
}

export function projectOrderDestination(
  projectIds: readonly string[],
  projectId: string,
  beforeProjectId: string | null
): ProjectOrderDestination | null {
  const current = [...projectIds];
  const sourceIndex = current.indexOf(projectId);
  if (sourceIndex < 0) return null;
  const requestedIndex = beforeProjectId === null ? current.length : current.indexOf(beforeProjectId);
  if (requestedIndex < 0) return null;
  current.splice(sourceIndex, 1);
  const insertionIndex = Math.min(requestedIndex - (sourceIndex < requestedIndex ? 1 : 0), current.length);
  current.splice(insertionIndex, 0, projectId);
  if (current.every((id, index) => id === projectIds[index])) return null;
  const next = current[insertionIndex + 1];
  if (next) return { beforeProjectId: next };
  const previous = current[insertionIndex - 1];
  return previous ? { afterProjectId: previous } : null;
}

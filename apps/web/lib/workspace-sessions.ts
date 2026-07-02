import type { WorkplaceProject } from '@monad/protocol';

export const safeDecode = (value: string): string => {
  let current = value;
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
};

export const getWorkplaceProjectName = (session: Pick<WorkplaceProject, 'title'>): string =>
  formatProjectDisplayName(safeDecode(session.title));

export const buildWorkspaceProjects = (projects: Pick<WorkplaceProject, 'id' | 'title' | 'cwd'>[] = []) =>
  projects.map((project) => ({ id: project.id, name: getWorkplaceProjectName(project), cwd: project.cwd }));

const createChannelName = (date = new Date()): string => {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  return `project-${stamp}`;
};

function formatProjectDisplayName(name: string): string {
  const match = /^project\s+(.+)$/.exec(name);
  if (!match) return name;
  const parsed = new Date(match[1]);
  if (Number.isNaN(parsed.getTime())) return name;
  return createChannelName(parsed);
}

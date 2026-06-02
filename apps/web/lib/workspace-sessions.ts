import type { Session } from '@monad/protocol';

export const WORKPLACE_PROJECT_PREFIX = 'Workplace: ';

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

export const isWorkplaceProject = (session: Pick<Session, 'title'>): boolean =>
  session.title.startsWith(WORKPLACE_PROJECT_PREFIX);

const getWorkplaceProjectSlug = (session: Pick<Session, 'title'>): string =>
  session.title.slice(WORKPLACE_PROJECT_PREFIX.length);

export const getWorkplaceProjectName = (session: Pick<Session, 'title'>): string =>
  formatProjectDisplayName(safeDecode(getWorkplaceProjectSlug(session)));

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

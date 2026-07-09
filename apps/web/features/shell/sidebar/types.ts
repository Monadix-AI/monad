import type { SessionId } from '@monad/protocol';
import type { useT } from '#/components/I18nProvider';

export interface ProjectItem {
  id: string;
  name: string;
  hasRunningAgent: boolean;
  pinned: boolean;
  sessions: { id: SessionId; title: string }[];
  unreadCount: number;
}

export type TFunction = ReturnType<typeof useT>;

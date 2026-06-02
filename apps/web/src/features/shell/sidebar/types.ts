import type { SessionAttentionState, SessionGenerationState, SessionId } from '@monad/protocol';
import type { useT } from '#/components/I18nProvider';

export interface ProjectItem {
  id: string;
  name: string;
  hasRunningAgent: boolean;
  sessions: {
    id: SessionId;
    pinned: boolean;
    title: string;
    attentionState?: SessionAttentionState | null;
    generationState?: SessionGenerationState | null;
    unreadItemKeys?: string[];
  }[];
  unreadCount: number;
}

export type TFunction = ReturnType<typeof useT>;

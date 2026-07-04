import type { NativeAgentDeliveryId, WorkspaceExperienceProjectDialogRequest } from '@monad/protocol';
import type { ReactElement } from 'react';
import type { ChatRoomCanvas } from '../utils/canvas.ts';
import type { ProjectComposerSurface } from '../utils/composer.ts';

import { cn } from '@monad/ui/lib/utils';
import { createElement, useMemo } from 'react';

import { workspaceExperienceT } from '../../i18n.ts';
import { useChatRoomExperienceStore } from '../store.ts';
import { AgentTasksRail } from './agent-tasks-rail.tsx';
import { ChatTranscript } from './chat-transcript.tsx';
import { Composer } from './composer/composer.tsx';

export type ChatRoomExperienceHostActions = {
  nativeCliAgentsHref: string;
  requestProjectDialog?: (request: WorkspaceExperienceProjectDialogRequest) => void;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
};

export type ChatRoomExperienceRuntime = {
  canvas: ChatRoomCanvas;
  composer: ProjectComposerSurface;
};

export const spawnAgentMemberDialogRequest = {
  intent: 'spawn-agent',
  open: true,
  type: 'project-settings'
} satisfies WorkspaceExperienceProjectDialogRequest;

export function requestSpawnAgentMemberDialog(
  requestProjectDialog: ChatRoomExperienceHostActions['requestProjectDialog']
): void {
  requestProjectDialog?.(spawnAgentMemberDialogRequest);
}

export function ChatRoomExperienceView({
  host,
  runtime
}: {
  host: ChatRoomExperienceHostActions;
  runtime: ChatRoomExperienceRuntime;
}): ReactElement {
  const room = runtime.canvas;
  const t = workspaceExperienceT();
  const followNativeCliSession = useChatRoomExperienceStore((state) => state.followNativeCliSession);
  const chatRoom = useMemo(
    () => ({
      ...room,
      followNativeCliSession: (id: string, deliveryId?: NativeAgentDeliveryId) =>
        followNativeCliSession(room.projectId, id, undefined, deliveryId)
    }),
    [followNativeCliSession, room]
  );
  return createElement(
    'div',
    { className: cn('flex min-h-0 min-w-0 flex-1') },
    createElement(
      'div',
      { className: cn('flex min-h-0 min-w-0 flex-1 flex-col') },
      createElement(
        'div',
        { className: cn('flex min-h-0 flex-1 flex-col') },
        createElement(ChatTranscript, {
          labels: {
            connectInStudio: t('web.workplace.emptyConnectInStudio'),
            emptyDescription: t('web.workplace.emptyChatDescription'),
            emptyTitle: t('web.workplace.emptyChatTitle'),
            jumpLatest: t('web.workplace.jumpLatest'),
            observe: t('web.workplace.observe'),
            spawnAgentMember: t('web.workplace.emptySpawnAgentMember'),
            working: t('web.workplace.working')
          },
          nativeCliAgentsHref: host.nativeCliAgentsHref,
          onSpawnAgentMember: () => requestSpawnAgentMemberDialog(host.requestProjectDialog),
          room: chatRoom
        })
      ),
      createElement(Composer, { room: runtime.composer, voiceModelState: host.voiceModelState ?? 'checking' })
    ),
    createElement(AgentTasksRail, { room })
  );
}

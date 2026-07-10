'use client';

import { Delete02Icon, PencilEdit01Icon } from '@hugeicons/core-free-icons';

import { SIDEBAR_ITEM_ROW_CLASS } from './nav-item';
import { getPreviewLessTargetCount, SidebarMoreLessControls, useSidebarPreviewCount } from './session-preview-controls';
import { useWorkspaceSidebar } from './workspace-sidebar-context';
import { WorkspaceTreeItem } from './workspace-tree-item';

export function ChatSessionList() {
  const { actions, meta, state } = useWorkspaceSidebar();
  const { activeChatSessionId, chatSessions } = state;
  const {
    showLess: showLessChatSessions,
    showMore: showMoreChatSessions,
    visibleCount: visibleChatSessionCount
  } = useSidebarPreviewCount();
  const visibleChatSessions = chatSessions.slice(0, visibleChatSessionCount);
  const lessTargetCount = getPreviewLessTargetCount(chatSessions, activeChatSessionId);

  return (
    <div className="flex flex-col gap-0.5">
      {chatSessions.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">{meta.t('web.sidebar.noSessions')}</p>
      ) : null}
      {visibleChatSessions.map((session) => {
        const active = activeChatSessionId === session.id;
        return (
          <WorkspaceTreeItem
            active={active}
            className={SIDEBAR_ITEM_ROW_CLASS}
            href={`/sessions/${encodeURIComponent(session.id)}`}
            key={session.id}
            label={session.title}
            menuActions={[
              {
                icon: PencilEdit01Icon,
                kind: 'rename',
                label: meta.t('web.sidebar.renameSession')
              },
              {
                icon: Delete02Icon,
                label: meta.t('web.sidebar.deleteSession'),
                onSelect: () => {
                  void actions.deleteChatSession(session.id);
                },
                shortcut: 'D',
                variant: 'destructive'
              }
            ]}
            menuLabel={meta.t('web.sidebar.itemMenu')}
            onOpen={() => actions.openSession(session.id)}
            onRename={(title) => actions.renameSession(session.id, title)}
            title={session.title}
          >
            <span className="block truncate">{session.title}</span>
          </WorkspaceTreeItem>
        );
      })}
      <SidebarMoreLessControls
        canShowLess={visibleChatSessionCount > lessTargetCount}
        canShowMore={visibleChatSessionCount < chatSessions.length}
        lessLabel={meta.t('web.sidebar.less')}
        moreLabel={meta.t('web.sidebar.more')}
        onShowLess={() => showLessChatSessions(lessTargetCount)}
        onShowMore={showMoreChatSessions}
      />
    </div>
  );
}

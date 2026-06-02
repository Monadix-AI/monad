import type { SessionId } from '@monad/protocol';
import type { ArchivedSessionListItem } from '#/features/shell/archived-sessions';
import type { TFunction } from './types';

import { ArrowLeft01Icon, Delete02Icon, FileArchiveIcon } from '@hugeicons/core-free-icons';
import { useMemo, useState } from 'react';

import { archivedSessionBuckets, visibleArchivedBucketItems } from '#/features/shell/archived-sessions';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { useServerSessionSearch } from '#/features/shell/session-server-search';
import { SIDEBAR_ITEM_ROW_CLASS, SidebarNavItem, SidebarNavSection } from './nav-item';
import { SidebarMoreLessControls } from './session-preview-controls';
import { WorkspaceSection } from './workspace-section';
import { WorkspaceTreeItem } from './workspace-tree-item';

const EARLIER_INITIAL_COUNT = 5;
const EARLIER_MORE_STEP = 10;

interface ArchivedSidebarItemsProps {
  chatSessions: ArchivedSessionListItem[];
  loading?: boolean;
  onBack: () => void;
  onDeleteSession: (sessionId: SessionId, title: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onOpenSession: (sessionId: SessionId) => void;
  onUnarchiveSession: (sessionId: SessionId) => void;
  projectSessions: ArchivedSessionListItem[];
  t: TFunction;
}

export function ArchivedSidebarItems({
  chatSessions,
  loading,
  onBack,
  onDeleteSession,
  onOpenProjectSession,
  onOpenSession,
  onUnarchiveSession,
  projectSessions,
  t
}: ArchivedSidebarItemsProps) {
  const [query, setQuery] = useState('');
  const [projectCollapsed, setProjectCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const { searching, sessions: searchSessions } = useServerSessionSearch({
    archived: true,
    limit: 200,
    query
  });
  const projectNames = useMemo(
    () =>
      new Map(
        projectSessions.flatMap((session) =>
          session.projectId && session.projectName ? [[session.projectId, session.projectName]] : []
        )
      ),
    [projectSessions]
  );
  const searchItems = useMemo<ArchivedSessionListItem[]>(
    () =>
      searchSessions.map((session) => ({
        id: session.id,
        projectId: session.projectId,
        projectName: session.projectId ? projectNames.get(session.projectId) : undefined,
        title: session.title,
        updatedAt: session.updatedAt
      })),
    [projectNames, searchSessions]
  );
  const searchingServer = query.trim().length > 0;
  const visibleItems = searchingServer && !searching ? searchItems : [...projectSessions, ...chatSessions];
  const visibleProjectSessions = visibleItems.filter((session) => session.projectId);
  const visibleChatSessions = visibleItems.filter((session) => !session.projectId);
  const showLoading = Boolean(loading);

  return (
    <>
      <SidebarNavSection>
        <SidebarNavItem
          icon={ArrowLeft01Icon}
          label={t('web.common.back')}
          onClick={onBack}
        />
      </SidebarNavSection>
      <div className="border-sidebar-border border-y px-3 py-2">
        <input
          className="h-8 w-full rounded-(--radius-md) bg-background px-2.5 text-sm shadow-[inset_0_0_0_1px_var(--input)] outline-none placeholder:text-muted-foreground focus:shadow-[inset_0_0_0_1px_rgb(var(--backgroundColor-accent)/0.48),0_0_0_2px_rgb(var(--backgroundColor-accent)/0.08)]"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search archived sessions..."
          value={query}
        />
      </div>
      <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 px-2.5 py-3">
          {showLoading ? <p className="px-2 py-2 text-muted-foreground text-xs">{t('web.common.loading')}</p> : null}
          {!showLoading && visibleProjectSessions.length === 0 && visibleChatSessions.length === 0 ? (
            <p className="px-2 py-2 text-muted-foreground text-xs">No archived sessions.</p>
          ) : null}
          {visibleProjectSessions.length > 0 ? (
            <WorkspaceSection
              collapsed={projectCollapsed}
              onToggle={() => setProjectCollapsed((collapsed) => !collapsed)}
              title="Project sessions"
            >
              <ArchivedBucketList
                items={visibleProjectSessions}
                lessLabel={t('web.sidebar.less')}
                moreLabel={t('web.sidebar.more')}
                onDeleteSession={onDeleteSession}
                onOpenProjectSession={onOpenProjectSession}
                onOpenSession={onOpenSession}
                onUnarchiveSession={onUnarchiveSession}
                t={t}
              />
            </WorkspaceSection>
          ) : null}
          {visibleChatSessions.length > 0 ? (
            <WorkspaceSection
              collapsed={chatCollapsed}
              onToggle={() => setChatCollapsed((collapsed) => !collapsed)}
              title="Chat sessions"
            >
              <ArchivedBucketList
                items={visibleChatSessions}
                lessLabel={t('web.sidebar.less')}
                moreLabel={t('web.sidebar.more')}
                onDeleteSession={onDeleteSession}
                onOpenProjectSession={onOpenProjectSession}
                onOpenSession={onOpenSession}
                onUnarchiveSession={onUnarchiveSession}
                t={t}
              />
            </WorkspaceSection>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ArchivedBucketList({
  items,
  lessLabel,
  moreLabel,
  onDeleteSession,
  onOpenProjectSession,
  onOpenSession,
  onUnarchiveSession,
  t
}: {
  items: ArchivedSessionListItem[];
  lessLabel: string;
  moreLabel: string;
  onDeleteSession: (sessionId: SessionId, title: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onOpenSession: (sessionId: SessionId) => void;
  onUnarchiveSession: (sessionId: SessionId) => void;
  t: TFunction;
}) {
  const [earlierVisibleCount, setEarlierVisibleCount] = useState(EARLIER_INITIAL_COUNT);
  const buckets = archivedSessionBuckets(items);

  return (
    <div className="flex flex-col gap-1">
      {buckets.map((bucket) => {
        const visibleItems = visibleArchivedBucketItems(bucket, earlierVisibleCount);
        const canShowMore = bucket.id === 'earlier' && visibleItems.length < bucket.items.length;
        return (
          <div key={bucket.id}>
            <div className="px-2 pb-1 text-[10px] text-muted-foreground leading-4">{bucket.label}</div>
            <div className="flex flex-col gap-0.5">
              {visibleItems.map((item) => (
                <ArchivedSessionRow
                  item={item}
                  key={item.id}
                  onDeleteSession={onDeleteSession}
                  onOpenProjectSession={onOpenProjectSession}
                  onOpenSession={onOpenSession}
                  onUnarchiveSession={onUnarchiveSession}
                  t={t}
                />
              ))}
              {bucket.id === 'earlier' ? (
                <SidebarMoreLessControls
                  canShowLess={earlierVisibleCount > EARLIER_INITIAL_COUNT}
                  canShowMore={canShowMore}
                  lessLabel={lessLabel}
                  moreLabel={moreLabel}
                  onShowLess={() => setEarlierVisibleCount(EARLIER_INITIAL_COUNT)}
                  onShowMore={() => setEarlierVisibleCount((count) => count + EARLIER_MORE_STEP)}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArchivedSessionRow({
  item,
  onDeleteSession,
  onOpenProjectSession,
  onOpenSession,
  onUnarchiveSession,
  t
}: {
  item: ArchivedSessionListItem;
  onDeleteSession: (sessionId: SessionId, title: string) => void;
  onOpenProjectSession: (projectId: string, sessionId: SessionId) => void;
  onOpenSession: (sessionId: SessionId) => void;
  onUnarchiveSession: (sessionId: SessionId) => void;
  t: TFunction;
}) {
  const sessionId = item.id as SessionId;
  const href = item.projectId
    ? projectSessionPath(item.projectId, sessionId)
    : `/sessions/${encodeURIComponent(item.id)}`;
  const open = () => {
    if (item.projectId) onOpenProjectSession(item.projectId, sessionId);
    else onOpenSession(sessionId);
  };

  return (
    <WorkspaceTreeItem
      active={false}
      className={SIDEBAR_ITEM_ROW_CLASS}
      href={href}
      label={item.title}
      menuActions={[
        {
          icon: FileArchiveIcon,
          label: t('web.sidebar.unarchiveSession'),
          onSelect: () => {
            onUnarchiveSession(sessionId);
          },
          shortcut: 'U'
        },
        {
          icon: Delete02Icon,
          label: t('web.sidebar.deleteSession'),
          onSelect: () => {
            onDeleteSession(sessionId, item.title);
          },
          shortcut: 'D',
          variant: 'destructive'
        }
      ]}
      menuLabel={t('web.sidebar.itemMenu')}
      onOpen={open}
      sidebarSession
      title={item.projectName ? `${item.projectName}: ${item.title}` : item.title}
    >
      <span className="block truncate">{item.title}</span>
    </WorkspaceTreeItem>
  );
}

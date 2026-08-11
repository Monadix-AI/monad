import type { SessionId, WorkspaceAction } from '@monad/protocol';
import type { ProjectController } from '../use-project';

import {
  ComputerTerminal01Icon,
  Copy01Icon,
  FolderOpenIcon,
  GitBranchIcon,
  PlusSignIcon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useWorkspaceActionMutation, useWorkspaceMetaQuery } from '@monad/client-rtk';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@monad/ui';
import { AgentIdentity, AgentInstanceAvatar } from '@monad/ui/components/AgentAvatar';

import { BrandIcon } from '#/components/BrandIcon';
import { useT } from '#/components/I18nProvider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#/components/ui/hover-card';
import { PanelShellBreadcrumbHeader } from '#/components/ui/panel-shell';
import { SessionHeaderTitle } from '#/features/session/SessionHeader';
import { meshWorkspaceStatusView } from '../mesh-workspace-status';
import { fileManagerLabel, terminalLabel, workdirLabel } from './project-header-utils';

function SessionMemberRoster({ room }: { room: ProjectController }): React.ReactElement {
  const t = useT();
  const countLabel = t('web.workplace.sessionMemberCount', { count: room.sessionMembers.length });

  return (
    <HoverCard
      closeDelay={100}
      openDelay={150}
    >
      <HoverCardTrigger asChild>
        <Button
          aria-label={countLabel}
          className="h-7 gap-1.5 px-2 font-mono text-xs tabular-nums"
          size="sm"
          type="button"
          variant="ghost"
        >
          <HugeiconsIcon
            aria-hidden
            icon={UserGroupIcon}
            size={14}
          />
          {room.sessionMembers.length}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="w-72 overflow-hidden p-0"
        side="bottom"
        sideOffset={6}
      >
        <div className="border-border/70 border-b px-3 py-2.5">
          <div className="font-medium text-sm">{t('web.workplace.sessionMembersTitle')}</div>
          <div className="mt-0.5 text-muted-foreground text-xs">{countLabel}</div>
        </div>
        {room.sessionMembers.length > 0 ? (
          <ul
            aria-label={t('web.workplace.sessionMembersTitle')}
            className="m-0 max-h-72 list-none overflow-y-auto overscroll-contain p-1.5"
          >
            {room.sessionMembers.map(({ member }) => {
              const identity = room.resolveAgentIdentity({ id: member.id, name: member.profileId });
              const name = identity?.name ?? member.displayName;
              return (
                <li
                  className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-2.5 rounded-md px-2 py-2"
                  key={member.id}
                >
                  <AgentInstanceAvatar
                    agent={{
                      av: identity?.av,
                      avatarUrl: identity?.avatarUrl,
                      name
                    }}
                    bare
                    size={28}
                  />
                  <AgentIdentity
                    badge={
                      identity?.providerIcon ? (
                        <span
                          aria-label={identity.providerIcon.title}
                          className="size-3.5"
                          role="img"
                          title={identity.providerIcon.title}
                        >
                          <BrandIcon
                            className="size-full"
                            icon={identity.providerIcon}
                          />
                        </span>
                      ) : undefined
                    }
                    className="min-w-0"
                    name={name}
                    nameStyle={{ fontSize: 13, fontWeight: 500 }}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 px-3 py-3 text-muted-foreground text-sm">{t('web.workplace.noSessionMembersHint')}</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function WorkdirControl({
  gitRemoteUrl,
  sessionId,
  workdir
}: {
  gitRemoteUrl?: string;
  sessionId?: SessionId;
  workdir: ProjectController['workdir'];
}): React.ReactElement {
  const t = useT();
  const [runWorkspaceAction, workspaceAction] = useWorkspaceActionMutation();

  const label = workdirLabel(workdir.path, t('web.workplace.workdirSettingsUnset'));
  const path = workdir.path;
  const copyPath = async () => {
    if (path) await navigator.clipboard.writeText(path);
  };
  const performWorkspaceAction = (action: WorkspaceAction) => {
    if (sessionId && path) void runWorkspaceAction({ id: sessionId, action });
  };
  const openGitHub = () => {
    if (gitRemoteUrl) window.open(gitRemoteUrl, '_blank', 'noopener,noreferrer');
  };
  const actionDisabled = !sessionId || !path || workspaceAction.isLoading;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className="max-w-[280px] gap-1.5 font-mono text-xs max-md:size-6 max-md:p-0"
          size="sm"
          title={workdir.path ?? t('web.workplace.workdirSettingsUnset')}
          type="button"
          variant="ghost"
        >
          <HugeiconsIcon
            aria-hidden
            className="size-3.5 shrink-0"
            icon={FolderOpenIcon}
          />
          <span className="truncate max-md:hidden">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-60"
      >
        <DropdownMenuItem
          disabled={actionDisabled}
          onSelect={() => performWorkspaceAction('show-in-file-manager')}
        >
          <HugeiconsIcon icon={FolderOpenIcon} />
          {fileManagerLabel(typeof navigator === 'undefined' ? undefined : navigator.platform)}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!path}
          onSelect={() => void copyPath()}
        >
          <HugeiconsIcon icon={Copy01Icon} />
          Copy path
        </DropdownMenuItem>
        {gitRemoteUrl ? (
          <DropdownMenuItem onSelect={openGitHub}>
            <HugeiconsIcon icon={GitBranchIcon} />
            Open repo in GitHub
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={actionDisabled}
          onSelect={() => performWorkspaceAction('open-terminal')}
        >
          <HugeiconsIcon icon={ComputerTerminal01Icon} />
          {terminalLabel(typeof navigator === 'undefined' ? undefined : navigator.platform)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectHeader({
  onAddMember,
  project: room
}: {
  onAddMember: () => void;
  project: ProjectController;
}): React.ReactElement {
  const t = useT();
  const activeProject = room.projects.find((p) => p.active);
  const { data: workspaceMeta } = useWorkspaceMetaQuery(room.activeSessionId ?? ('ses_' as SessionId), {
    skip: !room.activeSessionId || !room.workdir.path
  });
  const git = workspaceMeta?.git;
  const meshStatus = meshWorkspaceStatusView(room.source.meshAgentState);
  const activeSession = room.projectSessions.find((session) => session.id === room.activeSessionId);
  return (
    <PanelShellBreadcrumbHeader
      actions={
        <>
          {meshStatus.reconnecting ? (
            <span
              aria-live="polite"
              role="status"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: 'var(--foreground)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '4px 10px'
              }}
            >
              <span
                aria-hidden
                style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }}
              />
              {t('web.meshAgent.status.stale')}
            </span>
          ) : null}
          {room.activeSessionId ? (
            <>
              <SessionMemberRoster room={room} />
              <Button
                aria-label={t('web.workplace.addMember')}
                className="max-md:size-6 max-md:p-0"
                onClick={() => onAddMember()}
                size="sm"
                variant="ghost"
              >
                <HugeiconsIcon
                  icon={PlusSignIcon}
                  size={14}
                />
                <span className="max-md:hidden">{t('web.workplace.addMember')}</span>
              </Button>
            </>
          ) : null}
          <WorkdirControl
            gitRemoteUrl={git?.remoteUrl}
            sessionId={room.activeSessionId as SessionId | undefined}
            workdir={room.workdir}
          />
        </>
      }
      ariaLabel={t('web.workplace.projectSessionBreadcrumb')}
      crumbs={[
        { id: room.projectId, label: activeProject?.name ?? room.projectId },
        ...(activeSession
          ? [
              {
                id: activeSession.id,
                label: (
                  <SessionHeaderTitle
                    onRename={(title) => room.renameSession(activeSession.id, title)}
                    renameLabel={t('web.sidebar.renameSession')}
                    title={activeSession.title}
                  />
                )
              }
            ]
          : [])
      ]}
    />
  );
}

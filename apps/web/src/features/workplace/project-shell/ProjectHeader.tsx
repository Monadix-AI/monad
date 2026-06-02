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
import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';

import { useT } from '#/components/I18nProvider';
import { PanelShellBreadcrumbHeader } from '#/components/ui/panel-shell';
import { meshWorkspaceStatusView } from '../mesh-workspace-status';
import { fileManagerLabel, terminalLabel, workdirLabel } from './project-header-utils';

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
  const memberCount = room.sessionMembers.length;
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
              <span
                aria-label={t('web.workplace.sessionMemberCount', { count: memberCount })}
                role="status"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: mono, fontSize: 11 }}
              >
                <HugeiconsIcon
                  icon={UserGroupIcon}
                  size={14}
                />
                {memberCount}
              </span>
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
        ...(activeSession ? [{ id: activeSession.id, label: activeSession.title }] : [])
      ]}
    />
  );
}

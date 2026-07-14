import type { ProjectId, SessionId, WorkspaceAction } from '@monad/protocol';
import type { ProjectExperienceDefinition } from '#/features/workplace/experiences/types';
import type { ProjectController } from '#/features/workplace/use-project';

import {
  ChevronDownIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MessageSquareCodeIcon,
  NeuralNetworkIcon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useUpdateWorkplaceProjectMutation,
  useWorkspaceActionMutation,
  useWorkspaceMetaQuery
} from '@monad/client-rtk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@monad/ui';
import { Avatar } from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelShellBreadcrumbHeader } from '#/components/ui/panel-shell';
import { getProjectExperience } from '#/features/workplace/experiences/registry';
import { fileManagerLabel, terminalLabel, workdirLabel } from '#/features/workplace/project-shell/project-header-utils';

interface ProjectTopBarProps {
  mode: string;
  participants: ProjectController['participants'];
  projectName: string;
  projectWorkdir?: string;
  projectId: ProjectId | null;
  sessionId: SessionId | null;
  sessionTitle: string | null;
  experiences: ProjectExperienceDefinition[];
  onModeChange: (mode: string) => void;
  onOpenSettings: () => void;
}

const experienceIcon: Record<string, typeof MessageSquareCodeIcon> = {
  'git-fork': NeuralNetworkIcon,
  'message-square': MessageSquareCodeIcon
};

function iconForExperience(experience: ProjectExperienceDefinition): typeof MessageSquareCodeIcon {
  return experienceIcon[experience.icon ?? ''] ?? MessageSquareCodeIcon;
}

export function projectTopBarBreadcrumbItems({
  projectName,
  sessionTitle
}: {
  projectName: string;
  sessionTitle: string | null;
}): string[] {
  const title = sessionTitle?.trim();
  return title ? [projectName, title] : [projectName];
}

function ProjectTopBarWorkdir({
  path,
  projectId,
  sessionId
}: {
  path?: string;
  projectId: ProjectId | null;
  sessionId: SessionId | null;
}): React.ReactElement {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [updateWorkplaceProject, updateState] = useUpdateWorkplaceProjectMutation();
  const [runWorkspaceAction, actionState] = useWorkspaceActionMutation();
  const { data: workspaceMeta } = useWorkspaceMetaQuery(sessionId ?? ('ses_' as SessionId), {
    skip: !menuOpen || !sessionId || !path
  });
  const gitRemoteUrl = workspaceMeta?.git.remoteUrl;
  const busy = updateState.isLoading;

  const commit = async (value: string) => {
    if (!projectId) return;
    await updateWorkplaceProject({ id: projectId, cwd: value.trim() });
    setEditing(false);
  };
  const copyPath = async () => {
    if (path) await navigator.clipboard.writeText(path);
  };
  const performWorkspaceAction = (action: WorkspaceAction) => {
    if (sessionId && path) void runWorkspaceAction({ id: sessionId, action });
  };

  if (editing) {
    return (
      <input
        className="project-topbar-workdir-input"
        disabled={busy}
        onBlur={() => setEditing(false)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit(draft);
          if (event.key === 'Escape') setEditing(false);
        }}
        placeholder={t('web.workplace.workdirInputPlaceholder')}
        ref={(el) => el?.focus()}
        value={draft}
      />
    );
  }

  const disabled = !sessionId || !path || actionState.isLoading;
  return (
    <DropdownMenu
      onOpenChange={setMenuOpen}
      open={menuOpen}
    >
      <DropdownMenuTrigger asChild>
        <button
          className="project-topbar-workdir"
          onDoubleClick={() => {
            setDraft(path ?? '');
            setEditing(true);
          }}
          title={path ?? t('web.workplace.setFolderHint')}
          type="button"
        >
          {workdirLabel(path, t('web.workplace.setFolder'))}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-60"
      >
        <DropdownMenuItem
          disabled={disabled}
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
          <DropdownMenuItem onSelect={() => window.open(gitRemoteUrl, '_blank', 'noopener,noreferrer')}>
            <HugeiconsIcon icon={GitBranchIcon} />
            Open repo in GitHub
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => performWorkspaceAction('open-terminal')}
        >
          <HugeiconsIcon icon={ComputerTerminal01Icon} />
          {terminalLabel(typeof navigator === 'undefined' ? undefined : navigator.platform)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setDraft(path ?? '');
            setEditing(true);
          }}
        >
          <HugeiconsIcon icon={ExternalLinkIcon} />
          Change path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectTopBarParticipants({
  participants
}: {
  participants: ProjectController['participants'];
}): React.ReactElement | null {
  const agents = participants.filter((participant) => participant.kind === 'agent' && participant.id !== 'monad');
  if (agents.length === 0) return null;

  return (
    <div className="project-topbar-participants">
      {agents.slice(0, 6).map((participant, index) => (
        <div
          className="project-topbar-participant"
          key={participant.id}
          style={{ zIndex: agents.length - index }}
          title={participant.name}
        >
          <Avatar
            av={participant.av}
            avatarUrl={participant.avatarUrl}
            icon={participant.icon}
            kind={participant.kind}
            size={26}
          />
        </div>
      ))}
    </div>
  );
}

function ProjectTopBarExperienceSwitch({
  activeExperience,
  experiences,
  onModeChange
}: {
  activeExperience: ProjectExperienceDefinition | null;
  experiences: ProjectExperienceDefinition[];
  onModeChange: (mode: string) => void;
}): React.ReactElement {
  const t = useT();
  const ModeIcon = activeExperience ? iconForExperience(activeExperience) : MessageSquareCodeIcon;
  const activeLabel =
    activeExperience?.label ??
    (activeExperience?.labelKey
      ? t(activeExperience.labelKey)
      : (activeExperience?.id ?? t('web.workplace.experience.chat')));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={t('web.project.viewMode')}
          className="project-topbar-view"
          type="button"
        >
          <HugeiconsIcon
            icon={ModeIcon}
            size={14}
          />
          <span className="project-topbar-view-label">{activeLabel}</span>
          <HugeiconsIcon
            className="project-topbar-chevron"
            icon={ChevronDownIcon}
            size={14}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
      >
        {experiences.map((experience) => {
          const ExperienceIcon = iconForExperience(experience);
          const label = experience.label ?? (experience.labelKey ? t(experience.labelKey) : experience.id);
          const active = experience.id === activeExperience?.id;
          return (
            <DropdownMenuItem
              aria-current={active ? 'true' : undefined}
              key={experience.id}
              onSelect={() => onModeChange(experience.id)}
            >
              <HugeiconsIcon icon={ExperienceIcon} />
              <span>{label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectTopBar({
  mode,
  participants,
  projectName,
  projectWorkdir,
  projectId,
  sessionId,
  sessionTitle,
  experiences,
  onModeChange,
  onOpenSettings
}: ProjectTopBarProps) {
  const t = useT();
  const activeExperience = getProjectExperience(mode, experiences);
  const breadcrumbItems = projectTopBarBreadcrumbItems({ projectName, sessionTitle });

  return (
    <>
      <style>{`
        .project-topbar-workdir,
        .project-topbar-workdir-input {
          height: 24px;
          min-width: 0;
          max-width: min(32vw, 260px);
          border: 1px solid rgb(var(--borderColor-secondary) / .14);
          border-radius: 8px;
          background: rgb(var(--backgroundColor-state-enabled) / .34);
          color: rgb(var(--textColor-secondary));
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 11px;
        }
        .project-topbar-workdir {
          padding: 0 8px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .project-topbar-workdir-input {
          width: 240px;
          padding: 0 9px;
          outline: none;
        }
        .project-topbar-workdir:hover {
          background: rgb(var(--backgroundColor-state-hover) / .18);
          color: rgb(var(--textColor-primary));
        }
        .project-topbar-workdir:focus-visible,
        .project-topbar-workdir-input:focus-visible {
          box-shadow: 0 0 0 2px rgb(var(--outlineColor-accent) / .42);
        }
        .project-topbar-status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 22px;
          padding: 0 8px;
          border: 1px solid rgb(var(--borderColor-secondary) / .12);
          border-radius: 999px;
          background: rgb(var(--backgroundColor-state-enabled) / .38);
          color: rgb(var(--textColor-secondary));
          font-size: 11px;
        }
        .project-topbar-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: rgb(34 197 94);
          box-shadow: 0 0 8px rgb(34 197 94 / .5);
        }
        .project-topbar-spacer { flex: 1; }
        .project-topbar-participants {
          display: inline-flex;
          align-items: center;
          height: 28px;
          padding-inline: 4px 8px;
          flex: none;
        }
        .project-topbar-participant {
          position: relative;
          flex: none;
          margin-left: -8px;
          transition:
            margin-left 160ms ease,
            transform 160ms ease;
        }
        .project-topbar-participant:first-child {
          margin-left: 0;
        }
        .project-topbar-participant > div:first-child {
          border-radius: 999px !important;
          background: color-mix(in srgb, var(--accent-blue) 24%, var(--background)) !important;
        }
        .project-topbar-participants:hover .project-topbar-participant,
        .project-topbar-participants:focus-within .project-topbar-participant {
          margin-left: 3px;
        }
        .project-topbar-participants:hover .project-topbar-participant:first-child,
        .project-topbar-participants:focus-within .project-topbar-participant:first-child {
          margin-left: 0;
        }
        .project-topbar-participant:hover {
          transform: translateY(-1px);
        }
        @media (prefers-reduced-motion: reduce) {
          .project-topbar-participant {
            transition: none;
          }
        }
        .project-topbar-view {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          height: 28px;
          min-width: 142px;
          padding: 0 10px;
          border: 1px solid rgb(var(--borderColor-secondary) / .16);
          border-radius: 8px;
          background: rgb(var(--backgroundColor-state-enabled) / .42);
          color: rgb(var(--textColor-primary));
        }
        .project-topbar-view svg {
          flex-shrink: 0;
          color: rgb(var(--textColor-secondary));
        }
        .project-topbar-view-label {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 500;
        }
        .project-topbar-chevron {
          margin-left: auto;
        }
        .project-topbar-settings {
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgb(var(--borderColor-secondary) / .16);
          border-radius: 8px;
          background: rgb(var(--backgroundColor-state-enabled) / .28);
          color: rgb(var(--textColor-secondary));
        }
        .project-topbar-settings:hover,
        .project-topbar-view:hover {
          background: rgb(var(--backgroundColor-state-hover) / .18);
          color: rgb(var(--textColor-primary));
        }
      `}</style>
      <PanelShellBreadcrumbHeader
        actions={
          <>
            <ProjectTopBarParticipants participants={participants} />
            <ProjectTopBarExperienceSwitch
              activeExperience={activeExperience}
              experiences={experiences}
              onModeChange={onModeChange}
            />
            <button
              aria-label={t('web.project.openSettings')}
              className="project-topbar-settings"
              onClick={onOpenSettings}
              title={t('web.project.settings')}
              type="button"
            >
              <HugeiconsIcon
                icon={Settings02Icon}
                size={14}
              />
            </button>
          </>
        }
        badge={
          <ProjectTopBarWorkdir
            path={projectWorkdir}
            projectId={projectId}
            sessionId={sessionId}
          />
        }
        className="project-topbar project-topbar-clean"
        crumbs={breadcrumbItems.map((item, index) => ({
          id: index === 0 ? 'project' : `session:${index}`,
          label: (
            <span
              className="project-topbar-name"
              title={item}
            >
              {item}
            </span>
          )
        }))}
      />
    </>
  );
}

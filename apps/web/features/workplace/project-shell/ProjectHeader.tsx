import type { ProjectId, WorkspaceAction } from '@monad/protocol';
import type { ProjectController } from '../use-project';

import {
  ComputerTerminal01Icon,
  Copy01Icon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitBranchIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useWorkspaceActionMutation, useWorkspaceMetaQuery } from '@monad/client-rtk';
import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

function workdirLabel(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || trimmed || fallback;
}

function fileManagerLabel(): string {
  if (typeof navigator === 'undefined') return 'Show in file manager';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'Show in Finder';
  if (platform.includes('win')) return 'Show in Explorer';
  return 'Show in file manager';
}

function terminalLabel(): string {
  if (typeof navigator === 'undefined') return 'Open in terminal';
  return navigator.platform.toLowerCase().includes('mac') ? 'Open in Terminal' : 'Open in terminal';
}

/** Shared working folder for the project — set it once and every project agent resolves fs/shell paths
 *  against it. Empty input clears it back to the default workspace. */
function WorkdirControl({
  gitRemoteUrl,
  projectId,
  workdir
}: {
  gitRemoteUrl?: string;
  projectId?: ProjectId;
  workdir: ProjectController['workdir'];
}): React.ReactElement {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [runWorkspaceAction, workspaceAction] = useWorkspaceActionMutation();

  const commit = async (value: string) => {
    setBusy(true);
    try {
      await workdir.set(value.trim());
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <input
        className="h-8 rounded-full font-mono text-[11px]"
        disabled={busy}
        onBlur={() => setEditing(false)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit(draft);
          if (e.key === 'Escape') setEditing(false);
        }}
        placeholder={t('web.workplace.workdirInputPlaceholder')}
        ref={(el) => el?.focus()}
        style={{
          width: 240,
          border: `1px solid ${'var(--accent-blue)'}`,
          background: 'var(--card)',
          color: 'var(--foreground)',
          borderRadius: 999,
          padding: '0 12px'
        }}
        value={draft}
      />
    );
  }

  const label = workdirLabel(workdir.path, t('web.workplace.setFolder'));
  const path = workdir.path;
  const copyPath = async () => {
    if (path) await navigator.clipboard.writeText(path);
  };
  const performWorkspaceAction = (action: WorkspaceAction) => {
    if (projectId && path) void runWorkspaceAction({ id: projectId, action });
  };
  const openGitHub = () => {
    if (gitRemoteUrl) window.open(gitRemoteUrl, '_blank', 'noopener,noreferrer');
  };
  const actionDisabled = !projectId || !path || workspaceAction.isLoading;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="workplace-action"
          onDoubleClick={() => {
            setDraft(workdir.path ?? '');
            setEditing(true);
          }}
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: 'var(--foreground)',
            border: '1px solid transparent',
            background: 'transparent',
            borderRadius: 999,
            padding: '6px 10px',
            maxWidth: 280,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={workdir.path ?? t('web.workplace.setFolderHint')}
          type="button"
        >
          📁 {label}
        </button>
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
          {fileManagerLabel()}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!path}
          onSelect={() => void copyPath()}
        >
          <HugeiconsIcon icon={Copy01Icon} />
          Copy01Icon path
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
          {terminalLabel()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setDraft(workdir.path ?? '');
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

export function ProjectHeader({
  project: room
}: {
  project: ProjectController;
  embedded?: boolean;
}): React.ReactElement {
  const activeProject = room.projects.find((p) => p.active);
  const activeProjectId = activeProject?.id as ProjectId | undefined;
  const { data: workspaceMeta } = useWorkspaceMetaQuery(activeProjectId ?? ('prj_' as ProjectId), {
    skip: !activeProject?.id || !room.workdir.path
  });
  const git = workspaceMeta?.git;
  return (
    <div
      style={{
        minHeight: 68,
        flex: 'none',
        borderBottom: `1px solid ${'var(--border)'}`,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        padding: '12px 16px 10px',
        gap: '9px 18px',
        background: 'var(--card)'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '0 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <span style={{ fontSize: 18, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: 1.2 }}>
            # {activeProject?.name ?? room.projectId}
          </span>
        </div>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <WorkdirControl
          gitRemoteUrl={git?.remoteUrl}
          projectId={activeProject?.id as ProjectId | undefined}
          workdir={room.workdir}
        />
      </div>
    </div>
  );
}

'use client';

import type { Agent, AgentId, ProjectId, SessionId } from '@monad/protocol';

import { BotIcon, CheckIcon, Folder01Icon, LoaderPinwheelIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  createIdempotencyKey,
  useCreateProjectSessionMutation,
  useCreateSessionMutation,
  useSendMessageMutation,
  useSendProjectMessageMutation
} from '@monad/client-rtk';
import { newId } from '@monad/protocol';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@monad/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ComposerShell } from '#/features/session/ComposerShell';
import { useSessionUiStore } from '#/features/session/session-ui-store';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { pushShellUrl, replaceShellUrl } from '#/hooks/use-shell-location';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import {
  resolveWorkspaceLaunchTarget,
  workspaceLaunchErrorMessage,
  workspaceSessionTitleFromDraft
} from './workspace-home-model';

type HomeProject = { id: string; name: string; sessions?: { id: SessionId }[] };
type TargetMode = 'agent' | 'project';

interface WorkspaceHomeProps {
  agents: Agent[];
  projects: HomeProject[];
  activeProjectId: string | null;
  onOpenSettings: () => void;
  onOpenStudio: () => void;
}

export function WorkspaceHome({ agents, projects, activeProjectId, onOpenStudio }: WorkspaceHomeProps) {
  const t = useT();
  const [createSession] = useCreateSessionMutation();
  const [createProjectSession] = useCreateProjectSessionMutation();
  const [sendMessage] = useSendMessageMutation();
  const [sendProjectMessage] = useSendProjectMessageMutation();
  const clearComposerInput = useSessionUiStore((state) => state.clearComposerInput);
  const enqueueInitialUserMessage = useSessionUiStore((state) => state.enqueueInitialUserMessage);
  const addDraftChatSession = useWorkspaceShellStore((state) => state.addDraftChatSession);
  const failDraftChatSession = useWorkspaceShellStore((state) => state.failDraftChatSession);
  const removeDraftChatSession = useWorkspaceShellStore((state) => state.removeDraftChatSession);
  const newChatPrefill = useWorkspaceShellStore((state) => state.newChatPrefill);
  const setNewChatPrefill = useWorkspaceShellStore((state) => state.setNewChatPrefill);
  const [intent, setIntent] = useState('');
  const [targetMode, setTargetMode] = useState<TargetMode>('agent');
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(activeProjectId);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launchingRef = useRef(false);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const selectedAgent = selectedAgentId ? (agents.find((agent) => agent.id === selectedAgentId) ?? null) : null;
  const launchTarget = resolveWorkspaceLaunchTarget({
    mode: targetMode,
    selectedAgentSessionId: null,
    selectedProjectId: selectedProject?.id ?? null
  });
  const selectedTargetLabel =
    targetMode === 'project'
      ? (selectedProject?.name ?? t('web.workspace.chooseProject'))
      : (selectedAgent?.name ?? t('web.workspace.defaultAgent'));
  const actionLabel = targetMode === 'project' ? t('web.workspace.build') : t('web.workspace.chat');

  useEffect(() => {
    if (!newChatPrefill) return;
    if (newChatPrefill.mode === 'project') {
      setTargetMode('project');
      setSelectedProjectId(newChatPrefill.projectId);
      setSelectedAgentId(null);
    } else {
      setTargetMode('agent');
      setSelectedAgentId(null);
    }
    setNewChatPrefill(null);
  }, [newChatPrefill, setNewChatPrefill]);

  const selectMode = (mode: TargetMode): void => {
    setTargetMode(mode);
    setLaunchError(null);
  };

  const startDraftChatSession = (draft: string): void => {
    const title = workspaceSessionTitleFromDraft(draft, t('web.workspace.newChat'));
    const tempSessionId = newId('ses') as SessionId;
    const createIdempotencyKeyValue = createIdempotencyKey();
    const sendIdempotencyKeyValue = createIdempotencyKey();
    const createdAt = new Date().toISOString();
    addDraftChatSession({
      id: tempSessionId,
      title,
      text: draft,
      ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
      createIdempotencyKey: createIdempotencyKeyValue,
      sendIdempotencyKey: sendIdempotencyKeyValue,
      status: 'creating',
      createdAt,
      updatedAt: createdAt
    });
    clearComposerInput();
    setIntent('');

    window.setTimeout(() => {
      replaceShellUrl(`/sessions/${encodeURIComponent(tempSessionId)}`);
      window.setTimeout(() => {
        void createSession({
          title,
          ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
          idempotencyKey: createIdempotencyKeyValue
        })
          .unwrap()
          .then((realSessionId) => {
            const stillViewingDraft =
              typeof window !== 'undefined' && window.location.pathname === `/sessions/${tempSessionId}`;
            if (stillViewingDraft) {
              addDraftChatSession({
                id: realSessionId,
                title,
                text: draft,
                ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
                createIdempotencyKey: createIdempotencyKeyValue,
                sendIdempotencyKey: sendIdempotencyKeyValue,
                status: 'creating',
                createdAt,
                updatedAt: new Date().toISOString()
              });
              enqueueInitialUserMessage(realSessionId, draft);
              replaceShellUrl(`/sessions/${encodeURIComponent(realSessionId)}`);
              window.setTimeout(() => removeDraftChatSession(realSessionId), 2000);
            }
            removeDraftChatSession(tempSessionId);
            void sendMessage({ sessionId: realSessionId, text: draft, idempotencyKey: sendIdempotencyKeyValue });
          })
          .catch((error) => {
            failDraftChatSession(tempSessionId, workspaceLaunchErrorMessage(error) ?? t('web.workspace.launchError'));
          });
      }, 100);
    });
  };

  const start = async (): Promise<void> => {
    if (launchingRef.current) return;
    const draft = intent.trim();
    const target = resolveWorkspaceLaunchTarget({
      mode: targetMode,
      selectedAgentSessionId: null,
      selectedProjectId: selectedProject?.id ?? null
    });
    if (!draft || !target) return;

    if (target.kind === 'new-agent') {
      startDraftChatSession(draft);
      return;
    }

    launchingRef.current = true;
    setLaunching(true);
    setLaunchError(null);

    try {
      clearComposerInput();
      if (target.kind === 'existing-agent') {
        pushShellUrl(`/sessions/${encodeURIComponent(target.sessionId)}`);
        return;
      }
      if (target.kind === 'project') {
        const title = workspaceSessionTitleFromDraft(draft, selectedProject?.name ?? t('web.workspace.newChat'));
        const sessionId = await createProjectSession({
          projectId: target.projectId as ProjectId,
          title,
          idempotencyKey: createIdempotencyKey()
        }).unwrap();
        enqueueInitialUserMessage(sessionId, draft);
        void sendProjectMessage({ sessionId, text: draft });
        setIntent('');
        pushShellUrl(projectSessionPath(target.projectId, sessionId));
        return;
      }
    } catch (error) {
      setLaunchError(workspaceLaunchErrorMessage(error) ?? t('web.workspace.launchError'));
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  };

  return (
    <main
      aria-busy={launching}
      className="workspace-home-shell relative flex min-h-0 flex-1 overflow-y-auto bg-background"
      data-launching={launching ? 'true' : 'false'}
      data-target-mode={targetMode}
    >
      <div
        aria-hidden="true"
        className="workspace-home-background"
      />
      <div className="workspace-home-content relative z-10 mx-auto flex min-h-full w-full max-w-[54rem] flex-col justify-center px-5 py-8 sm:px-8 sm:py-12">
        <section
          aria-labelledby="workspace-intent-title"
          className="workspace-home-intent"
        >
          <h1
            className="workspace-home-prompt text-balance font-normal text-4xl text-foreground tracking-normal sm:text-5xl"
            id="workspace-intent-title"
          >
            <span>{t('web.workspace.iWantTo')}</span>
            <ActionDropdown
              disabled={launching}
              onSelect={selectMode}
              t={t}
              targetMode={targetMode}
              value={actionLabel}
            />
            <span>{t('web.workspace.withInline')}</span>
            <TargetDropdown
              agents={agents}
              disabled={launching}
              onOpenStudio={onOpenStudio}
              onSelectAgent={(agentId) => {
                setSelectedAgentId(agentId);
                setLaunchError(null);
              }}
              onSelectProject={(projectId) => {
                setSelectedProjectId(projectId);
                setLaunchError(null);
              }}
              projects={projects}
              selectedAgentId={selectedAgentId}
              selectedProjectId={selectedProject?.id ?? null}
              t={t}
              targetMode={targetMode}
              value={selectedTargetLabel}
            />
          </h1>
          <div className="workspace-home-composer mt-4">
            <ComposerShell
              ariaLabel={t('web.workspace.iWantToDo')}
              busy={launching}
              controls={{
                access: false,
                context: false,
                model: false,
                submit: true,
                voice: false
              }}
              disabled={!launchTarget || launching}
              onChange={(value) => {
                setIntent(value);
                if (launchError) setLaunchError(null);
              }}
              onSubmit={() => void start()}
              placeholder={t('web.workspace.newChatPlaceholder')}
              value={intent}
            />
          </div>

          <div
            aria-live="polite"
            className="workspace-home-state-line"
          >
            {launching ? (
              <>
                <HugeiconsIcon
                  aria-hidden
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  icon={LoaderPinwheelIcon}
                />
                {t('web.workspace.launching')}
              </>
            ) : (
              <>
                <HugeiconsIcon
                  aria-hidden
                  className="size-3.5"
                  icon={CheckIcon}
                />
                {selectedTargetLabel}
              </>
            )}
          </div>
          {launchError ? (
            <p
              className="workspace-home-error"
              role="alert"
            >
              {launchError}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function ActionDropdown({
  disabled,
  onSelect,
  targetMode,
  t,
  value
}: {
  disabled: boolean;
  onSelect: (mode: TargetMode) => void;
  targetMode: TargetMode;
  t: ReturnType<typeof useT>;
  value: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="workspace-home-token"
          disabled={disabled}
          type="button"
        >
          {value}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="min-w-40"
      >
        <DropdownMenuItem
          aria-checked={targetMode === 'agent'}
          onSelect={() => onSelect('agent')}
          role="menuitemradio"
        >
          <HugeiconsIcon icon={BotIcon} />
          <span>{t('web.workspace.chat')}</span>
          {targetMode === 'agent' ? <HugeiconsIcon icon={CheckIcon} /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          aria-checked={targetMode === 'project'}
          onSelect={() => onSelect('project')}
          role="menuitemradio"
        >
          <HugeiconsIcon icon={Folder01Icon} />
          <span>{t('web.workspace.build')}</span>
          {targetMode === 'project' ? <HugeiconsIcon icon={CheckIcon} /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TargetDropdown({
  agents,
  disabled,
  onOpenStudio,
  onSelectAgent,
  onSelectProject,
  projects,
  selectedAgentId,
  selectedProjectId,
  targetMode,
  t,
  value
}: {
  agents: Agent[];
  disabled: boolean;
  onOpenStudio: () => void;
  onSelectAgent: (agentId: AgentId | null) => void;
  onSelectProject: (projectId: string) => void;
  projects: HomeProject[];
  selectedAgentId: AgentId | null;
  selectedProjectId: string | null;
  targetMode: TargetMode;
  t: ReturnType<typeof useT>;
  value: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="workspace-home-token workspace-home-token--target"
          disabled={disabled}
          type="button"
        >
          {value}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="w-72"
      >
        {targetMode === 'agent' ? (
          <>
            <WorkspaceOptionItem
              description={t('web.workspace.defaultAgentHint')}
              icon={PlusSignIcon}
              onSelect={() => onSelectAgent(null)}
              selected={!selectedAgentId}
              title={t('web.workspace.defaultAgent')}
            />
            {agents.map((agent) => (
              <WorkspaceOptionItem
                description={agent.description ?? t('web.workspace.agentOptionHint')}
                icon={BotIcon}
                key={agent.id}
                onSelect={() => onSelectAgent(agent.id)}
                selected={selectedAgentId === agent.id}
                title={agent.name}
              />
            ))}
          </>
        ) : projects.length > 0 ? (
          projects.map((project) => (
            <WorkspaceOptionItem
              description={t('web.workspace.existingProject')}
              icon={Folder01Icon}
              key={project.id}
              onSelect={() => onSelectProject(project.id)}
              selected={selectedProjectId === project.id}
              title={project.name}
            />
          ))
        ) : (
          <DropdownMenuItem onSelect={onOpenStudio}>
            <HugeiconsIcon icon={Folder01Icon} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{t('web.workplace.noProjects')}</span>
              <span className="block truncate text-muted-foreground text-xs">{t('web.workspace.noProjectsHint')}</span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceOptionItem({
  description,
  icon,
  onSelect,
  selected,
  title
}: {
  description: string;
  icon: typeof BotIcon;
  onSelect: () => void;
  selected: boolean;
  title: string;
}) {
  return (
    <DropdownMenuItem
      aria-checked={selected}
      onSelect={onSelect}
      role="menuitemradio"
    >
      <HugeiconsIcon icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-muted-foreground text-xs">{description}</span>
      </span>
      {selected ? <HugeiconsIcon icon={CheckIcon} /> : null}
    </DropdownMenuItem>
  );
}

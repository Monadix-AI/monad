import type { ProjectId, SendMessageAttachment, SessionId } from '@monad/protocol';

import { Cancel01Icon, CheckIcon, CpuIcon, Folder01Icon, PlusSignIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  createIdempotencyKey,
  meshAgentAdapter,
  meshAgentSelectors,
  profileAdapter,
  profileSelectors,
  useCreateProjectSessionMutation,
  useCreateSessionMutation,
  useCreateWorkplaceProjectMutation,
  useListMeshAgentsQuery,
  useListProfilesQuery,
  useSendMessageMutation,
  useSendProjectMessageMutation
} from '@monad/client-rtk';
import { newId } from '@monad/protocol';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@monad/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';
import { ComposerShell } from '#/features/session/ComposerShell';
import { enqueueInitialUserMessageForSession, useSessionUiStore } from '#/features/session/session-ui-store';
import { messageAttachmentsFromSend, useComposerAttachments } from '#/features/session/use-composer-attachments';
import { NewProjectDialog } from '#/features/shell/NewProjectDialog';
import { projectSessionPath } from '#/features/shell/routing/paths';
import { pushShellUrl, replaceShellUrl } from '#/hooks/use-shell-location';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';
import {
  createAndSendWorkspaceDraft,
  resolveWorkspaceLaunchTarget,
  workspaceDraftCanLaunch,
  workspaceLaunchErrorMessage,
  workspaceSessionTitleFromDraft,
  workspaceSetupActions
} from './workspace-home-model';

type HomeProject = { id: string; name: string; sessions?: { id: SessionId }[] };

interface WorkspaceHomeProps {
  projects: HomeProject[];
}

export function WorkspaceHome({ projects }: WorkspaceHomeProps) {
  const t = useT();
  const [createSession] = useCreateSessionMutation();
  const [createProjectSession] = useCreateProjectSessionMutation();
  const [createWorkplaceProject] = useCreateWorkplaceProjectMutation();
  const [sendMessage] = useSendMessageMutation();
  const [sendProjectMessage] = useSendProjectMessageMutation();
  const profilesQuery = useListProfilesQuery();
  const meshAgentsQuery = useListMeshAgentsQuery();
  const clearComposerInput = useSessionUiStore((state) => state.clearComposerInput);
  const addDraftChatSession = useWorkspaceShellStore((state) => state.addDraftChatSession);
  const failDraftChatSession = useWorkspaceShellStore((state) => state.failDraftChatSession);
  const removeDraftChatSession = useWorkspaceShellStore((state) => state.removeDraftChatSession);
  const newSessionProjectId = useWorkspaceShellStore((state) => state.newSessionProjectId);
  const setNewSessionProjectId = useWorkspaceShellStore((state) => state.setNewSessionProjectId);
  const [intent, setIntent] = useState('');
  const [createdProject, setCreatedProject] = useState<HomeProject | null>(null);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launchingRef = useRef(false);
  const {
    addFiles: addComposerFiles,
    attachmentItems,
    clearAttachments: clearComposerAttachments,
    error: composerAttachmentError,
    openAttachment,
    removeAttachment,
    sendableAttachments: composerAttachments
  } = useComposerAttachments('workspace-home');
  const projectOptions = useMemo(
    () =>
      createdProject && !projects.some((project) => project.id === createdProject.id)
        ? [...projects, createdProject]
        : projects,
    [createdProject, projects]
  );
  const selectedProject = useMemo(
    () => projectOptions.find((project) => project.id === newSessionProjectId) ?? null,
    [newSessionProjectId, projectOptions]
  );
  const targetMode = selectedProject ? 'project' : 'agent';
  const launchTarget = resolveWorkspaceLaunchTarget({
    mode: targetMode,
    selectedAgentSessionId: null,
    selectedProjectId: selectedProject?.id ?? null
  });
  const selectedTargetLabel = selectedProject?.name ?? t('web.workspace.noProjectShort');
  const profiles = useMemo(
    () => profileSelectors.selectAll(profilesQuery.data?.profiles ?? profileAdapter.getInitialState()),
    [profilesQuery.data?.profiles]
  );
  const meshAgents = useMemo(
    () => meshAgentSelectors.selectAll(meshAgentsQuery.data ?? meshAgentAdapter.getInitialState()),
    [meshAgentsQuery.data]
  );
  const setupActions = useMemo(
    () =>
      profilesQuery.isSuccess && meshAgentsQuery.isSuccess
        ? workspaceSetupActions({
            meshAgentConnected: meshAgents.some((agent) => agent.enabled),
            profileConfigured: profiles.some(
              (profile) => profile.alias === (profilesQuery.data.defaultAlias || 'default')
            )
          })
        : [],
    [meshAgents, meshAgentsQuery.isSuccess, profiles, profilesQuery.data, profilesQuery.isSuccess]
  );

  useEffect(() => {
    if (createdProject && projects.some((project) => project.id === createdProject.id)) setCreatedProject(null);
  }, [createdProject, projects]);

  const createProject = async (args: { cwd?: string; name: string }): Promise<void> => {
    const projectId = await createWorkplaceProject({ cwd: args.cwd, title: args.name }).unwrap();
    setCreatedProject({ id: projectId, name: args.name });
    setNewSessionProjectId(projectId);
    setLaunchError(null);
    setNewProjectDialogOpen(false);
  };

  const startDraftChatSession = (draft: string, attachments: SendMessageAttachment[]): void => {
    const title = workspaceSessionTitleFromDraft(draft, t('web.workspace.newChat'));
    const tempSessionId = newId('ses') as SessionId;
    const createIdempotencyKeyValue = createIdempotencyKey();
    const sendIdempotencyKeyValue = createIdempotencyKey();
    const createdAt = new Date().toISOString();
    const draftSession = {
      attachments,
      id: tempSessionId,
      title,
      text: draft,
      createIdempotencyKey: createIdempotencyKeyValue,
      sendIdempotencyKey: sendIdempotencyKeyValue,
      status: 'creating',
      createdAt,
      updatedAt: createdAt
    } as const;
    addDraftChatSession(draftSession);
    clearComposerInput();
    clearComposerAttachments();
    setIntent('');

    window.setTimeout(() => {
      replaceShellUrl(`/sessions/${encodeURIComponent(tempSessionId)}`);
      window.setTimeout(() => {
        void createAndSendWorkspaceDraft(draftSession, {
          createSession,
          sendMessage,
          onSessionCreated: (serverSessionId) => {
            addDraftChatSession({
              ...draftSession,
              serverSessionId,
              updatedAt: new Date().toISOString()
            });
          }
        })
          .then((realSessionId) => {
            const stillViewingDraft =
              typeof window !== 'undefined' && window.location.pathname === `/sessions/${tempSessionId}`;
            if (stillViewingDraft) {
              addDraftChatSession({
                ...draftSession,
                id: realSessionId,
                updatedAt: new Date().toISOString()
              });
              enqueueInitialUserMessageForSession(realSessionId, {
                attachments: messageAttachmentsFromSend(draftSession.attachments, {
                  createdAt: draftSession.createdAt
                }),
                text: draft
              });
              replaceShellUrl(`/sessions/${encodeURIComponent(realSessionId)}`);
            }
            removeDraftChatSession(tempSessionId);
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
    const attachments = composerAttachments;
    const target = resolveWorkspaceLaunchTarget({
      mode: targetMode,
      selectedAgentSessionId: null,
      selectedProjectId: selectedProject?.id ?? null
    });
    if (!workspaceDraftCanLaunch(draft, attachments) || !target) return;

    if (target.kind === 'new-agent') {
      startDraftChatSession(draft, attachments);
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
        enqueueInitialUserMessageForSession(sessionId, {
          attachments: messageAttachmentsFromSend(attachments),
          text: draft
        });
        void sendProjectMessage({ sessionId, text: draft, ...(attachments.length ? { attachments } : {}) });
        setIntent('');
        clearComposerAttachments();
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
            <span>{t('web.workspace.build')}</span>
            <span>{t('web.workspace.inInline')}</span>
            <ProjectDropdown
              disabled={launching}
              onCreateProject={() => setNewProjectDialogOpen(true)}
              onSelectProject={(projectId) => {
                setNewSessionProjectId(projectId);
                setLaunchError(null);
              }}
              projects={projectOptions}
              selectedProjectId={selectedProject?.id ?? null}
              t={t}
              value={selectedTargetLabel}
            />
          </h1>
          <div className="workspace-home-composer mt-4">
            <ComposerShell
              ariaLabel={t('web.workspace.iWantToDo')}
              attachmentError={
                composerAttachmentError === 'read'
                  ? t('web.chat.attachmentReadError')
                  : composerAttachmentError === 'open'
                    ? t('web.chat.attachmentOpenError')
                    : undefined
              }
              attachments={attachmentItems}
              busy={launching}
              controls={{
                access: false,
                context: false,
                model: false,
                submit: true,
                voice: false
              }}
              disabled={!launchTarget || launching}
              onAttachFiles={addComposerFiles}
              onChange={(value) => {
                setIntent(value);
                if (launchError) setLaunchError(null);
              }}
              onOpenAttachment={(localId) => void openAttachment(localId)}
              onRemoveAttachment={removeAttachment}
              onSubmit={() => void start()}
              placeholder={t('web.workspace.newChatPlaceholder')}
              value={intent}
            />
          </div>

          {setupActions.length > 0 ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {setupActions.map((action) => {
                const profileAction = action.id === 'profile';
                return (
                  <ShellLink
                    className="group flex min-h-32 flex-col rounded-[1.35rem] border border-border/80 bg-card px-5 py-4 shadow-sm transition-[border-color,background-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-foreground/20 hover:bg-card hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    href={action.href}
                    key={action.id}
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      className={cn(
                        'size-5',
                        profileAction ? 'text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'
                      )}
                      icon={profileAction ? CpuIcon : TerminalIcon}
                    />
                    <span className="mt-auto max-w-56 pt-8 font-medium text-foreground text-lg leading-snug tracking-tight">
                      {t(profileAction ? 'web.workspace.setupProfileAction' : 'web.workspace.connectMeshAgentAction')}
                    </span>
                  </ShellLink>
                );
              })}
            </div>
          ) : null}

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
      <NewProjectDialog
        onClose={() => setNewProjectDialogOpen(false)}
        onCreate={(args) => void createProject(args)}
        open={newProjectDialogOpen}
      />
    </main>
  );
}

function ProjectDropdown({
  disabled,
  onCreateProject,
  onSelectProject,
  projects,
  selectedProjectId,
  t,
  value
}: {
  disabled: boolean;
  onCreateProject: () => void;
  onSelectProject: (projectId: string | null) => void;
  projects: HomeProject[];
  selectedProjectId: string | null;
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
        {projects.map((project) => (
          <WorkspaceOptionItem
            icon={Folder01Icon}
            key={project.id}
            onSelect={() => onSelectProject(project.id)}
            selected={selectedProjectId === project.id}
            title={project.name}
          />
        ))}
        {projects.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={onCreateProject}>
          <HugeiconsIcon icon={PlusSignIcon} />
          <span className="min-w-0 flex-1 truncate">{t('web.workplace.newProject')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          aria-checked={!selectedProjectId}
          onSelect={() => onSelectProject(null)}
          role="menuitemradio"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
          <span className="min-w-0 flex-1 truncate">{t('web.workspace.noProject')}</span>
          {!selectedProjectId ? <HugeiconsIcon icon={CheckIcon} /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceOptionItem({
  icon,
  onSelect,
  selected,
  title
}: {
  icon: typeof Folder01Icon;
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
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {selected ? <HugeiconsIcon icon={CheckIcon} /> : null}
    </DropdownMenuItem>
  );
}

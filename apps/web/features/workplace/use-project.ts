'use client';

// Single chokepoint between the workspace shell and the live monad backend.
// Experience-specific transcript, rail, and composer projections live in atoms.

import type { ExternalAgentSessionView, ProfileView, ProjectId, UIItem, WorkplaceProject } from '@monad/protocol';

import { useProjectExperienceProjection } from '@monad/atoms/workspace-experiences';
import {
  externalAgentSessionSelectors,
  profileSelectors,
  useGetAppearanceQuery,
  useGetProfileSettingsQuery,
  useListExternalAgentSessionsQuery,
  useListProfilesQuery,
  useListWorkplaceProjectsQuery,
  useStreamUiItemsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { useEffect, useMemo, useState } from 'react';

import { useAcpAgentSettings } from '@/hooks/use-acp-agent-settings';
import { useExternalAgentSettings } from '@/hooks/use-external-agent-settings';
import { useTranscriptHistory } from '@/hooks/use-transcript-history';
import { normalizedComposerSettings } from '@/lib/composer-settings';
import { getWorkplaceProjectName } from '@/lib/workspace-sessions';
import { DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED, useProjectDebugStore } from './debug/project-debug-store';
import { useWorkspaceProjectExperienceRuntime } from './experiences/project-experience-adapter';
import { useProjectActions } from './use-project-actions';

const EMPTY_PROFILES: ProfileView[] = [];
const EMPTY_ITEMS: UIItem[] = [];
const EMPTY_EXTERNAL_AGENT_SESSIONS: ExternalAgentSessionView[] = [];

export function useProject(
  projectId: string,
  opts: { openAgentCard?: (memberId: string) => void; switchExperience?: (id: string) => void } = {}
) {
  const [resolvedProjectId, setResolvedProjectId] = useState<ProjectId | null>(null);

  // --- projects ---
  const { data: projectData } = useListWorkplaceProjectsQuery(undefined);
  const { data: userProfile } = useGetProfileSettingsQuery();
  const { data: appearance } = useGetAppearanceQuery();
  const composerSettings = normalizedComposerSettings(appearance?.composer);
  const { data: profileData } = useListProfilesQuery(undefined);
  const workplaceProjects: WorkplaceProject[] = useMemo(
    () => workplaceProjectSelectors.selectAll(projectData?.projects ?? workplaceProjectAdapter.getInitialState()),
    [projectData]
  );
  const modelProfiles = useMemo(
    () => (profileData ? profileSelectors.selectAll(profileData.profiles) : EMPTY_PROFILES),
    [profileData]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId is the route param that resets the resolved project session.
  useEffect(() => {
    setResolvedProjectId(null);
  }, [projectId]);

  useEffect(() => {
    const existing = workplaceProjects.find((project) => project.id === projectId);
    if (existing) {
      if (resolvedProjectId !== existing.id) setResolvedProjectId(existing.id);
      return;
    }
    if (projectData && resolvedProjectId !== null) setResolvedProjectId(null);
  }, [projectData, projectId, workplaceProjects, resolvedProjectId]);

  const currentProject = useMemo(
    () => (resolvedProjectId ? (workplaceProjects.find((project) => project.id === resolvedProjectId) ?? null) : null),
    [workplaceProjects, resolvedProjectId]
  );
  const activeProjectId = currentProject?.id ?? null;

  // --- live stream + lazy older history ---
  const stream = useStreamUiItemsQuery(activeProjectId ?? ('prj_' as ProjectId), { skip: activeProjectId === null });
  const externalAgentSessionsQ = useListExternalAgentSessionsQuery(activeProjectId ?? ('prj_' as ProjectId), {
    skip: activeProjectId === null
  });
  const transcript = useTranscriptHistory({
    transcriptTargetId: activeProjectId,
    streamOldestCursor: stream.data?.oldestCursor,
    streamHasMore: stream.data?.hasMore ?? false
  });

  const acp = useAcpAgentSettings();
  const externalAgent = useExternalAgentSettings();
  const externalAgentSessions = useMemo(
    () =>
      externalAgentSessionsQ.data
        ? externalAgentSessionSelectors.selectAll(externalAgentSessionsQ.data)
        : EMPTY_EXTERNAL_AGENT_SESSIONS,
    [externalAgentSessionsQ.data]
  );
  const projection = useProjectExperienceProjection({
    acpAgents: acp.agents,
    activeProjectId,
    appearanceAvatarStyle: appearance?.avatarStyle,
    currentProject,
    liveItems: stream.data?.items ?? EMPTY_ITEMS,
    externalAgents: externalAgent.agents,
    externalAgentSessions,
    projectId,
    projectName: getWorkplaceProjectName,
    userAvatarDataUrl: userProfile?.avatarDataUrl ?? undefined,
    userDisplayName: userProfile?.displayName,
    workplaceProjects
  });
  const {
    approvals,
    availableProjectMembers,
    human,
    liveItems,
    liveTools,
    externalAgentAvatarSeeds,
    externalAgentDisplayNames,
    externalAgentIcons,
    externalAgentTags,
    participants,
    projectParticipants,
    projectMembers,
    projects
  } = projection;
  const showDevSystemMessagesInStream = useProjectDebugStore((state) => state.showDevSystemMessagesInStream);

  const loadOlder = transcript.loadOlder;

  const {
    sendDirective,
    resolveApproval,
    answerQuestion,
    pauseAll,
    deleteProject,
    switchProject,
    addProjectMember,
    removeProjectMember,
    updateProjectMemberSettings,
    updateProjectMemberIdentity,
    sendExternalAgentInput,
    stopExternalAgent,
    setWorkdir
  } = useProjectActions({
    activeProjectId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents: acp.agents,
    externalAgents: externalAgent.agents,
    avatarStyle: appearance?.avatarStyle,
    setResolvedProjectId
  });

  const controller = useMemo(
    () => ({
      projectId,
      activeProjectId,
      ready: activeProjectId !== null,
      // live collections
      projects,
      participants,
      projectParticipants,
      projectMembers,
      availableProjectMembers,
      approvals,
      loadOlder,
      modelProfiles,
      sendShortcut: composerSettings.sendShortcut,
      followUpBehavior: composerSettings.followUpBehavior,
      source: {
        project: currentProject,
        transcriptItems: transcript.items,
        liveItems,
        liveTools,
        externalAgentSessions,
        human,
        avatarStyle: appearance?.avatarStyle,
        externalAgentAvatarSeeds,
        externalAgentTags,
        externalAgentDisplayNames,
        externalAgentIcons,
        showDeveloperOnlyMessages: DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED && showDevSystemMessagesInStream
      },
      workdir: { path: currentProject?.cwd, set: setWorkdir },
      paused: false,
      // actions
      sendDirective,
      resolveApproval,
      answerQuestion,
      pauseAll,
      deleteProject,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendExternalAgentInput,
      stopExternalAgent
    }),
    [
      activeProjectId,
      projectId,
      projects,
      participants,
      projectParticipants,
      projectMembers,
      availableProjectMembers,
      approvals,
      loadOlder,
      modelProfiles,
      composerSettings.sendShortcut,
      composerSettings.followUpBehavior,
      currentProject,
      transcript.items,
      liveItems,
      liveTools,
      externalAgentSessions,
      human,
      appearance?.avatarStyle,
      externalAgentAvatarSeeds,
      externalAgentTags,
      externalAgentDisplayNames,
      externalAgentIcons,
      showDevSystemMessagesInStream,
      currentProject?.cwd,
      setWorkdir,
      sendDirective,
      resolveApproval,
      answerQuestion,
      pauseAll,
      deleteProject,
      switchProject,
      addProjectMember,
      removeProjectMember,
      updateProjectMemberSettings,
      updateProjectMemberIdentity,
      sendExternalAgentInput,
      stopExternalAgent
    ]
  );
  const experienceRuntime = useWorkspaceProjectExperienceRuntime(controller, opts);

  return useMemo(() => {
    return {
      ...controller,
      experienceRuntime
    };
  }, [controller, experienceRuntime]);
}

export type ProjectController = ReturnType<typeof useProject>;

import type { AvatarStyle, ProjectId, WorkplaceProject } from '@monad/protocol';
import type { useAcpAgentSettings } from '@/hooks/use-acp-agent-settings';
import type { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';
import type { ApprovalView } from './types';

import {
  useAbortSessionMutation,
  useApproveNativeCliSessionMutation,
  useApproveToolMutation,
  useClarifyRespondMutation,
  useDeleteWorkplaceProjectMutation,
  useInputNativeCliSessionMutation,
  useSendProjectMessageMutation,
  useStopNativeCliSessionMutation,
  useUpdateWorkplaceProjectMutation
} from '@monad/client-rtk';
import { workplaceProjectMembersExtKey } from '@monad/protocol';
import { useCallback } from 'react';

import { traceProjectDebugOperation } from '@/lib/project-debug-trace';
import {
  type AddProjectMemberOptions,
  defaultProjectMemberSettings,
  nativeCliProductDisplayName,
  newNativeCliInstanceId,
  type ProjectMember,
  type ProjectMemberSettings,
  type ProjectMemberType,
  productIcon,
  projectMemberAvatarSeeds,
  projectMemberId,
  renameNativeCliProjectMemberDisplayName,
  safeNativeCliDisplayName,
  uniqueNativeCliDisplayName,
  warmEntityAvatar
} from './project-projection';

export type ApprovalDecision = 'approve' | 'reject';

/** Every mutating action `useProject` exposes: message send, approval/clarify resolution, session
 *  lifecycle, and project-member CRUD. Extracted from useProject because these are a cohesive,
 *  self-contained action surface — each callback only needs the RTK mutation hooks and the handful
 *  of computed values passed in, none of the surrounding view-building state. */
export function useProjectActions(args: {
  activeProjectId: ProjectId | null;
  currentProject: WorkplaceProject | null;
  projectMembers: ProjectMember[];
  approvals: ApprovalView[];
  acpAgents: ReturnType<typeof useAcpAgentSettings>['agents'];
  nativeCliAgents: ReturnType<typeof useNativeCliAgentSettings>['agents'];
  avatarStyle?: AvatarStyle;
  setResolvedProjectId: (id: ProjectId | null) => void;
}) {
  const {
    activeProjectId,
    currentProject,
    projectMembers,
    approvals,
    acpAgents,
    nativeCliAgents,
    avatarStyle,
    setResolvedProjectId
  } = args;

  const [sendProjectMessage] = useSendProjectMessageMutation();
  const [approveTool] = useApproveToolMutation();
  const [clarifyRespond] = useClarifyRespondMutation();
  const [approveNativeCliSession] = useApproveNativeCliSessionMutation();
  const [abortSession] = useAbortSessionMutation();
  const [updateWorkplaceProject] = useUpdateWorkplaceProjectMutation();
  const [deleteWorkplaceProject] = useDeleteWorkplaceProjectMutation();
  const [inputNativeCliSession] = useInputNativeCliSessionMutation();
  const [stopNativeCliSession] = useStopNativeCliSessionMutation();

  const sendDirective = useCallback(
    async (text: string) => {
      if (!activeProjectId) return;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'project.message.send', sessionId: activeProjectId, data: { text } },
        () => sendProjectMessage({ projectId: activeProjectId, text }).unwrap()
      );
    },
    [activeProjectId, sendProjectMessage]
  );

  const resolveApproval = useCallback(
    (requestId: string, decision: ApprovalDecision) => {
      const approval = approvals.find((candidate) => candidate.id === requestId);
      if (activeProjectId && approval?.approvalOwnership === 'provider-owned' && approval.nativeCliSessionId) {
        void traceProjectDebugOperation(
          {
            layer: 'web',
            label: 'native-cli.approval.resolve',
            sessionId: approval.nativeCliSessionId,
            data: { requestId, decision }
          },
          () =>
            approveNativeCliSession({
              id: approval.nativeCliSessionId as string,
              transcriptTargetId: activeProjectId,
              requestId,
              allow: decision === 'approve',
              ...(decision === 'reject' ? { reason: 'denied by operator' } : {})
            }).unwrap()
        );
        return;
      }
      void traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'tool.approval.resolve',
          sessionId: activeProjectId ?? undefined,
          data: { requestId, decision }
        },
        () =>
          approveTool({
            requestId,
            allow: decision === 'approve',
            scope: 'once',
            ...(decision === 'reject' ? { reason: 'denied by operator' } : {})
          }).unwrap()
      );
    },
    [activeProjectId, approveNativeCliSession, approveTool, approvals]
  );

  const answerQuestion = useCallback(
    (requestId: string, answer: string) => {
      void traceProjectDebugOperation(
        {
          layer: 'web',
          label: 'clarify.respond',
          sessionId: activeProjectId ?? undefined,
          data: { requestId }
        },
        () => clarifyRespond({ requestId, answer }).unwrap()
      );
    },
    [activeProjectId, clarifyRespond]
  );

  const pauseAll = useCallback(() => {
    if (activeProjectId) void abortSession(activeProjectId);
  }, [activeProjectId, abortSession]);

  const deleteProject = useCallback(async () => {
    if (!activeProjectId) return;
    const deletedProjectId = activeProjectId;
    setResolvedProjectId(null);
    try {
      await traceProjectDebugOperation({ layer: 'web', label: 'project.delete', sessionId: deletedProjectId }, () =>
        deleteWorkplaceProject(deletedProjectId).unwrap()
      );
    } catch (error) {
      setResolvedProjectId(deletedProjectId);
      throw error;
    }
  }, [activeProjectId, deleteWorkplaceProject, setResolvedProjectId]);

  const switchProject = useCallback((id: string) => setResolvedProjectId(id as ProjectId), [setResolvedProjectId]);

  const updateProjectMembers = useCallback(
    async (nextMembers: ProjectMember[]) => {
      if (!currentProject?.origin) return;
      await updateWorkplaceProject({
        id: currentProject.id,
        origin: {
          ...currentProject.origin,
          ext: {
            ...(currentProject.origin.ext ?? {}),
            [workplaceProjectMembersExtKey]: nextMembers.map(
              ({ type, name, templateName, displayName, instanceId, settings }) => ({
                type,
                name,
                ...(templateName ? { templateName } : {}),
                ...(displayName ? { displayName } : {}),
                ...(instanceId ? { instanceId } : {}),
                ...(settings && Object.keys(settings).length > 0 ? { settings } : {})
              })
            )
          }
        }
      }).unwrap();
      for (const seed of projectMemberAvatarSeeds(currentProject.id, nextMembers)) warmEntityAvatar(seed, avatarStyle);
    },
    [currentProject, updateWorkplaceProject, avatarStyle]
  );

  const addProjectMember = useCallback(
    async (type: ProjectMemberType, name: string, options: AddProjectMemberOptions = {}) => {
      if (type !== 'native-cli' && projectMembers.some((member) => member.type === type && member.name === name))
        return;
      const acpAgent = type === 'acp' ? acpAgents.find((agent) => agent.name === name) : undefined;
      const nativeAgent = type === 'native-cli' ? nativeCliAgents.find((agent) => agent.name === name) : undefined;
      const settings = {
        ...defaultProjectMemberSettings(type, type === 'acp' ? acpAgent : nativeAgent),
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
        ...(options.customPrompt ? { customPrompt: options.customPrompt } : {})
      };
      if (type === 'native-cli') {
        const defaultDisplayName = nativeCliProductDisplayName(
          productIcon(nativeAgent?.productIcon),
          nativeAgent?.provider,
          name
        );
        const displayName = safeNativeCliDisplayName(
          uniqueNativeCliDisplayName(options.displayName?.trim() || defaultDisplayName, projectMembers)
        );
        const instanceId = newNativeCliInstanceId(name);
        await updateProjectMembers([
          ...projectMembers,
          {
            id: instanceId,
            type,
            name: displayName,
            templateName: name,
            displayName,
            instanceId,
            settings
          }
        ]);
        return;
      }
      await updateProjectMembers([...projectMembers, { id: projectMemberId(type, name), type, name, settings }]);
    },
    [acpAgents, nativeCliAgents, projectMembers, updateProjectMembers]
  );

  const removeProjectMember = useCallback(
    async (id: string) => {
      await updateProjectMembers(projectMembers.filter((member) => member.id !== id));
    },
    [projectMembers, updateProjectMembers]
  );

  const updateProjectMemberSettings = useCallback(
    async (id: string, patch: ProjectMemberSettings) => {
      await updateProjectMembers(
        projectMembers.map((member) =>
          member.id === id ? { ...member, settings: { ...(member.settings ?? {}), ...patch } } : member
        )
      );
    },
    [projectMembers, updateProjectMembers]
  );

  const updateProjectMemberIdentity = useCallback(
    async (id: string, patch: { displayName?: string }) => {
      await updateProjectMembers(
        projectMembers.map((member) => {
          if (member.id !== id) return member;
          return renameNativeCliProjectMemberDisplayName(member, patch.displayName);
        })
      );
    },
    [projectMembers, updateProjectMembers]
  );

  const sendNativeCliInput = useCallback(
    async (id: string, input: string) => {
      if (!activeProjectId) return;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'native-cli.input', sessionId: id, data: { id, input } },
        () => inputNativeCliSession({ id, transcriptTargetId: activeProjectId, input }).unwrap()
      );
    },
    [activeProjectId, inputNativeCliSession]
  );
  const stopNativeCli = useCallback(
    async (id: string) => {
      if (!activeProjectId) return;
      await traceProjectDebugOperation({ layer: 'web', label: 'native-cli.stop', sessionId: id, data: { id } }, () =>
        stopNativeCliSession({ id, transcriptTargetId: activeProjectId }).unwrap()
      );
    },
    [activeProjectId, stopNativeCliSession]
  );

  const setWorkdir = useCallback(
    async (path: string) => {
      if (!currentProject) return;
      await updateWorkplaceProject({ id: currentProject.id, cwd: path }).unwrap();
    },
    [currentProject, updateWorkplaceProject]
  );

  return {
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
    sendNativeCliInput,
    stopNativeCli,
    setWorkdir
  };
}

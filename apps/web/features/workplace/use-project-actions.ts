import type {
  AvatarStyle,
  NativeCliAppServerTransport,
  ProjectId,
  SendMessageAttachment,
  WorkplaceProject,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType,
  WorkplaceProjectMemberView
} from '@monad/protocol';
import type { useAcpAgentSettings } from '@/hooks/use-acp-agent-settings';
import type { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';

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
import {
  defaultWorkplaceProjectMemberSettings,
  entityAvatarWriteUrl,
  nativeCliProductDisplayName,
  newNativeCliInstanceId,
  renameNativeCliProjectMemberDisplayName,
  safeNativeCliDisplayName,
  uniqueNativeCliDisplayName,
  workplaceProjectMemberAvatarSeeds,
  workplaceProjectMemberId,
  workplaceProjectMembersExtKey
} from '@monad/protocol';
import { useCallback } from 'react';

import { traceProjectDebugOperation } from '@/lib/project-debug-trace';

export type ApprovalDecision = 'approve' | 'reject';

type ProjectApprovalActionView = {
  id: string;
  approvalOwnership?: 'provider-owned';
  nativeCliSessionId?: string;
};

type AddProjectMemberOptions = {
  displayName?: string;
  projectTemplateId?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  appServerTransport?: NativeCliAppServerTransport;
  customPrompt?: string;
};

function warmEntityAvatar(seed: string, avatarStyle?: AvatarStyle): void {
  void fetch(entityAvatarWriteUrl(seed, avatarStyle), { method: 'POST' }).catch(() => {});
}

/** Every mutating action `useProject` exposes: message send, approval/clarify resolution, session
 *  lifecycle, and project-member CRUD. Extracted from useProject because these are a cohesive,
 *  self-contained action surface — each callback only needs the RTK mutation hooks and the handful
 *  of computed values passed in, none of the surrounding view-building state. */
export function useProjectActions(args: {
  activeProjectId: ProjectId | null;
  approvals: ProjectApprovalActionView[];
  currentProject: WorkplaceProject | null;
  projectMembers: WorkplaceProjectMemberView[];
  acpAgents: ReturnType<typeof useAcpAgentSettings>['agents'];
  nativeCliAgents: ReturnType<typeof useNativeCliAgentSettings>['agents'];
  avatarStyle?: AvatarStyle;
  setResolvedProjectId: (id: ProjectId | null) => void;
}) {
  const {
    activeProjectId,
    approvals,
    currentProject,
    projectMembers,
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
    async (directive: string | { attachments?: SendMessageAttachment[]; text: string }) => {
      if (!activeProjectId) return;
      const text = typeof directive === 'string' ? directive : directive.text;
      const attachments = typeof directive === 'string' ? undefined : directive.attachments;
      await traceProjectDebugOperation(
        { layer: 'web', label: 'project.message.send', sessionId: activeProjectId, data: { attachments, text } },
        () => sendProjectMessage({ projectId: activeProjectId, text, attachments }).unwrap()
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
    async (nextMembers: WorkplaceProjectMemberView[]) => {
      if (!currentProject?.origin) return;
      await updateWorkplaceProject({
        id: currentProject.id,
        origin: {
          ...currentProject.origin,
          ext: {
            ...(currentProject.origin.ext ?? {}),
            [workplaceProjectMembersExtKey]: nextMembers.map(
              ({ type, name, templateName, projectTemplateId, displayName, instanceId, settings }) => ({
                type,
                name,
                ...(templateName ? { templateName } : {}),
                ...(projectTemplateId ? { projectTemplateId } : {}),
                ...(displayName ? { displayName } : {}),
                ...(instanceId ? { instanceId } : {}),
                ...(settings && Object.keys(settings).length > 0 ? { settings } : {})
              })
            )
          }
        }
      }).unwrap();
      for (const seed of workplaceProjectMemberAvatarSeeds(currentProject.id, nextMembers)) {
        warmEntityAvatar(seed, avatarStyle);
      }
    },
    [currentProject, updateWorkplaceProject, avatarStyle]
  );

  const addProjectMember = useCallback(
    async (type: WorkplaceProjectMemberType, name: string, options: AddProjectMemberOptions = {}) => {
      if (type !== 'native-cli' && projectMembers.some((member) => member.type === type && member.name === name))
        return;
      const acpAgent = type === 'acp' ? acpAgents.find((agent) => agent.name === name) : undefined;
      const nativeAgent = type === 'native-cli' ? nativeCliAgents.find((agent) => agent.name === name) : undefined;
      const settings = {
        ...defaultWorkplaceProjectMemberSettings(type, type === 'acp' ? acpAgent : nativeAgent),
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
        ...(options.appServerTransport ? { appServerTransport: options.appServerTransport } : {}),
        ...(options.customPrompt ? { customPrompt: options.customPrompt } : {})
      };
      if (type === 'native-cli') {
        const defaultDisplayName = nativeCliProductDisplayName(nativeAgent?.productIcon, nativeAgent?.provider, name);
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
            ...(options.projectTemplateId ? { projectTemplateId: options.projectTemplateId } : {}),
            displayName,
            instanceId,
            settings
          }
        ]);
        return;
      }
      await updateProjectMembers([
        ...projectMembers,
        { id: workplaceProjectMemberId(type, name), type, name, settings }
      ]);
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
    async (id: string, patch: WorkplaceProjectMemberSettings) => {
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

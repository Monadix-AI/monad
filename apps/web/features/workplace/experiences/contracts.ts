import type { ContextUsagePayload, NativeCliProvider, ProfileView, ProjectId } from '@monad/protocol';
import type {
  AddProjectMemberOptions,
  ProjectMember,
  ProjectMemberSettings,
  ProjectMemberType
} from '../project-projection';
import type { ApprovalView, Participant, Project } from '../types';

interface ProjectMemberCandidate {
  id: string;
  type: ProjectMemberType;
  name: string;
  label: string;
  tag: string;
  enabled: boolean;
  modelOptions: string[];
  reasoningEfforts: string[];
  icon?: Participant['icon'];
  provider?: NativeCliProvider;
}

export interface ProjectMentionTarget {
  id: string;
  name: string;
}

interface ProjectWorkdirController {
  path?: string;
  set: (path: string) => Promise<void>;
}

export interface ProjectExperienceSnapshot {
  projectId: string;
  activeProjectId: ProjectId | null;
  projects: Project[];
  railAgents: Participant[];
  projectMembers: ProjectMember[];
  availableProjectMembers: ProjectMemberCandidate[];
  contextUsage?: ContextUsagePayload;
  modelProfiles: ProfileView[];
  approvals: ApprovalView[];
  workdir: ProjectWorkdirController;
  paused: boolean;
  mentionTargets: ProjectMentionTarget[];
}

export interface ProjectExperienceActions {
  loadOlder: () => void;
  sendDirective: (text: string) => Promise<void>;
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  pauseAll: () => void;
  addProjectMember: (type: ProjectMemberType, name: string, options?: AddProjectMemberOptions) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: ProjectMemberSettings) => Promise<void>;
  sendNativeCliInput: (id: string, input: string) => Promise<void>;
  stopNativeCli: (id: string) => Promise<void>;
  switchExperience: (id: string) => void;
}

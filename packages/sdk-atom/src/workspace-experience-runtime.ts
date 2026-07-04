import type {
  NativeCliAppServerTransport,
  NativeCliProvider,
  ProfileView,
  ProjectId,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType,
  WorkplaceProjectMemberView
} from '@monad/protocol';

/**
 * The data/action contract a workspace experience consumes from its host. Published here (framework-
 * agnostic, no React, no zod) so a third-party experience codes against a real type instead of the
 * `unknown` the event-bridge `WorkspaceExperienceHostApi` defaults to. These are browser-side UI
 * view-models delivered host→component in one realm (no wire boundary), so they stay pure TS — not
 * `@monad/protocol`, which is for parsed wire shapes and bans UI concepts.
 *
 * Bump WORKSPACE_EXPERIENCE_API_VERSION on any breaking change; the host stamps it onto the payload so
 * a component can refuse/degrade against an older major.
 */
export const WORKSPACE_EXPERIENCE_API_VERSION = 1 as const;
export type WorkspaceExperienceApiVersion = typeof WORKSPACE_EXPERIENCE_API_VERSION;

export type WorkspaceExperienceProductIconId =
  | 'codex'
  | 'claude-code'
  | 'gemini'
  | 'gemini-cli'
  | 'qwen'
  | 'openclaw'
  | 'hermes';

export type WorkspaceExperienceIcon = 'monad' | WorkspaceExperienceProductIconId | 'openai' | 'anthropic' | 'google';

export interface WorkspaceExperienceProject {
  id: string;
  name: string;
  unread?: number;
  active?: boolean;
}

export interface WorkspaceExperienceWorkdir {
  path?: string;
  set: (path: string) => Promise<void>;
}

export type WorkspaceExperienceMember = WorkplaceProjectMemberView;
export type WorkspaceExperienceMemberType = WorkplaceProjectMemberType;
export type WorkspaceExperienceMemberSettings = WorkplaceProjectMemberSettings;

export interface WorkspaceExperienceAddMemberOptions {
  displayName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  appServerTransport?: NativeCliAppServerTransport;
  customPrompt?: string;
}

export interface WorkspaceExperienceMemberCandidate {
  id: string;
  type: WorkspaceExperienceMemberType;
  name: string;
  label: string;
  tag: string;
  enabled: boolean;
  modelOptions: string[];
  reasoningEfforts: string[];
  icon?: WorkspaceExperienceIcon;
  provider?: NativeCliProvider;
  supportedAppServerTransports?: NativeCliAppServerTransport[];
}

export interface WorkspaceExperienceSnapshot {
  projectId: string;
  activeProjectId: ProjectId | null;
  projects: WorkspaceExperienceProject[];
  projectMembers: WorkspaceExperienceMember[];
  availableProjectMembers: WorkspaceExperienceMemberCandidate[];
  modelProfiles: ProfileView[];
  workdir: WorkspaceExperienceWorkdir;
  paused: boolean;
}

export interface WorkspaceExperienceActions {
  loadOlder: () => void;
  sendDirective: (text: string) => Promise<void> | void;
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  pauseAll: () => void;
  addProjectMember: (
    type: WorkspaceExperienceMemberType,
    name: string,
    options?: WorkspaceExperienceAddMemberOptions
  ) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: WorkspaceExperienceMemberSettings) => Promise<void>;
  sendNativeCliInput: (id: string, input: string) => Promise<void>;
  stopNativeCli: (id: string) => Promise<void>;
  switchExperience: (id: string) => void;
}

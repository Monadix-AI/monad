import type {
  ExternalAgentAppServerTransport,
  ExternalAgentProjectTemplate,
  ExternalAgentProvider,
  ProfileView,
  ProjectId,
  SendMessageAttachment,
  SessionId,
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

export type WorkspaceExperienceMember = WorkplaceProjectMemberView & { joinedAt?: string };
export type WorkspaceExperienceMemberType = WorkplaceProjectMemberType;
export type WorkspaceExperienceMemberSettings = WorkplaceProjectMemberSettings;

export interface WorkspaceExperienceAddMemberOptions {
  displayName?: string;
  projectTemplateId?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  appServerTransport?: ExternalAgentAppServerTransport;
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
  modelOptionDisplayNames?: Record<string, string>;
  reasoningEfforts: string[];
  icon?: WorkspaceExperienceIcon;
  provider?: ExternalAgentProvider;
  supportedAppServerTransports?: ExternalAgentAppServerTransport[];
  template?: ExternalAgentProjectTemplate;
}

/** A live participant node in the activity graph (the human + each project agent), with presence so a
 *  consumer can colour it. Kept as plain data (no React, no graph-layout library) so a same-origin
 *  web-component experience can render it however it likes. */
export interface WorkspaceExperienceGraphParticipant {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  presence: 'online' | 'working' | 'needs-login' | 'failed' | 'stopped' | 'idle';
}

/** A recent tool invocation surfaced on the activity graph. */
export interface WorkspaceExperienceGraphActivityRow {
  id: string;
  status: 'running' | 'ok' | 'error';
  tool: string;
}

/** The activity-graph projection: participants (with live presence) plus recent tool activity. The
 *  host computes it from its live stream and stamps it onto every snapshot so a web-component
 *  experience (e.g. the first-party graph-view) can render presence + activity without a private data
 *  channel. Optional so third-party experiences that don't need it — and snapshot producers that don't
 *  compute it — aren't forced to. */
export interface WorkspaceExperienceGraphCanvas {
  participants: WorkspaceExperienceGraphParticipant[];
  activity: WorkspaceExperienceGraphActivityRow[];
}

export interface WorkspaceExperienceSnapshot {
  projectId: string;
  activeProjectId: ProjectId | null;
  /** The project's currently-active session (Track B: a project HAS sessions; a third-party
   *  experience needs this to scope session-level host calls, not the project id). */
  activeSessionId: SessionId | null;
  projects: WorkspaceExperienceProject[];
  projectMembers: WorkspaceExperienceMember[];
  availableProjectMembers: WorkspaceExperienceMemberCandidate[];
  modelProfiles: ProfileView[];
  workdir: WorkspaceExperienceWorkdir;
  paused: boolean;
  graphCanvas?: WorkspaceExperienceGraphCanvas;
}

export interface WorkspaceExperienceActions {
  loadOlder: () => void;
  sendDirective: (directive: string | { attachments?: SendMessageAttachment[]; text: string }) => Promise<void> | void;
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  pauseAll: () => void;
  addProjectMember: (
    type: WorkspaceExperienceMemberType,
    name: string,
    options?: WorkspaceExperienceAddMemberOptions
  ) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: WorkspaceExperienceMemberSettings) => Promise<void>;
  sendExternalAgentInput: (id: string, input: string) => Promise<void>;
  stopExternalAgent: (id: string) => Promise<void>;
  switchExperience: (id: string) => void;
  /** Navigate from an Experience-owned task to the host's full project-session view. */
  openProjectSession?: (sessionId: string) => void;
}

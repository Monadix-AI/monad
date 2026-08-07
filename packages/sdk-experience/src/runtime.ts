import type {
  AgentSessionSnapshot,
  MeshAgentProvider,
  ProfileView,
  ProjectId,
  SendMessageAttachment,
  SessionId,
  WorkplaceProjectMemberSettings,
  WorkplaceProjectMemberType,
  WorkplaceProjectMemberView
} from '@monad/protocol';

/**
 * The data/action contract a workplace experience consumes from its host. Published here (framework-
 * agnostic, no React, no zod) so a third-party experience codes against a real type instead of the
 * `unknown` the event-bridge `WorkplaceExperienceHostApi` defaults to. These are browser-side UI
 * view-models delivered host→component in one realm (no wire boundary), so they stay pure TS — not
 * `@monad/protocol`, which is for parsed wire shapes and bans UI concepts.
 *
 * Bump WORKPLACE_EXPERIENCE_API_VERSION on any breaking change; the host stamps it onto the payload so
 * a component can refuse/degrade against an older major.
 */
export const WORKPLACE_EXPERIENCE_API_VERSION = 2 as const;
export type WorkplaceExperienceApiVersion = typeof WORKPLACE_EXPERIENCE_API_VERSION;

export type WorkplaceApprovalDecision = 'approve' | 'approve-once' | 'approve-session' | 'approve-always' | 'reject';

export type WorkplaceExperienceProductIconId =
  | 'codex'
  | 'claude-code'
  | 'antigravity'
  | 'gemini'
  | 'gemini-cli'
  | 'qwen'
  | 'openclaw'
  | 'hermes';

export type WorkplaceExperienceIcon = 'monad' | WorkplaceExperienceProductIconId | 'openai' | 'anthropic' | 'google';

export interface WorkplaceExperienceProject {
  id: string;
  name: string;
  unread?: number;
  active?: boolean;
}

export interface WorkplaceExperienceWorkdir {
  path?: string;
}

export type WorkplaceExperienceMember = WorkplaceProjectMemberView & {
  agentSession?: AgentSessionSnapshot;
  joinedAt?: string;
};
export type WorkplaceExperienceMemberType = WorkplaceProjectMemberType;
export type WorkplaceExperienceMemberSettings = WorkplaceProjectMemberSettings;

export interface WorkplaceExperienceAddMemberOptions {
  displayName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
}

export interface WorkplaceExperienceMemberCandidate {
  id: string;
  type: WorkplaceExperienceMemberType;
  name: string;
  label: string;
  tag: string;
  enabled: boolean;
  modelOptions: string[];
  modelOptionDisplayNames?: Record<string, string>;
  speedsByModel?: Record<string, string[]>;
  reasoningEfforts: string[];
  executionCapabilities: { autopilot: boolean; fastMode: boolean };
  icon?: WorkplaceExperienceIcon;
  provider?: MeshAgentProvider;
}

/** A live participant node in the activity graph (the human + each project agent), with presence so a
 *  consumer can colour it. Kept as plain data (no React, no graph-layout library) so a same-origin
 *  web-component experience can render it however it likes. */
export interface WorkplaceExperienceGraphParticipant {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  presence: 'online' | 'working' | 'sleeping' | 'waking' | 'needs-login' | 'failed' | 'stopped' | 'idle';
}

/** A recent tool invocation surfaced on the activity graph. */
export interface WorkplaceExperienceGraphActivityRow {
  id: string;
  status: 'running' | 'ok' | 'error';
  tool: string;
}

/** The activity-graph projection: participants (with live presence) plus recent tool activity. The
 *  host computes it from its live stream and stamps it onto every snapshot so a web-component
 *  experience (e.g. the first-party graph-view) can render presence + activity without a private data
 *  channel. Optional so third-party experiences that don't need it — and snapshot producers that don't
 *  compute it — aren't forced to. */
export interface WorkplaceExperienceGraphCanvas {
  participants: WorkplaceExperienceGraphParticipant[];
  activity: WorkplaceExperienceGraphActivityRow[];
}

export interface WorkplaceExperienceSnapshot {
  projectId: string;
  activeProjectId: ProjectId | null;
  /** The project's currently-active session (Track B: a project HAS sessions; a third-party
   *  experience needs this to scope session-level host calls, not the project id). */
  activeSessionId: SessionId | null;
  projects: WorkplaceExperienceProject[];
  projectMembers: WorkplaceExperienceMember[];
  availableProjectMembers: WorkplaceExperienceMemberCandidate[];
  modelProfiles: ProfileView[];
  workdir: WorkplaceExperienceWorkdir;
  paused: boolean;
  graphCanvas?: WorkplaceExperienceGraphCanvas;
}

export interface WorkplaceExperienceActions {
  /** Load older rows; returns false when no load started so the scroll edge stays armed. */
  loadOlder: () => boolean;
  sendDirective: (directive: string | { attachments?: SendMessageAttachment[]; text: string }) => Promise<void> | void;
  resolveApproval: (requestId: string, decision: WorkplaceApprovalDecision) => void;
  pauseAll: () => void;
  addProjectMember: (
    type: WorkplaceExperienceMemberType,
    name: string,
    options?: WorkplaceExperienceAddMemberOptions
  ) => Promise<void>;
  removeProjectMember: (id: string) => Promise<void>;
  updateProjectMemberSettings: (id: string, patch: WorkplaceExperienceMemberSettings) => Promise<void>;
  sendMeshAgentInput: (id: string, input: string) => Promise<void>;
  stopMeshAgent: (id: string) => Promise<void>;
  switchExperience: (id: string) => void;
  /** Navigate from an Experience-owned task to the host's full project-session view. */
  openProjectSession?: (sessionId: string) => void;
}

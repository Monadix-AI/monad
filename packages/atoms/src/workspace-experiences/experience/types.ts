import type { MessageAttachmentRef, NativeAgentDeliveryId, NativeCliObservationEvent } from '@monad/protocol';
import type { WorkspaceExperienceIcon, WorkspaceExperienceProject } from '@monad/sdk-atom';

export type { WorkspaceExperienceProductIconId } from '@monad/sdk-atom';
export type ParticipantKind = 'human' | 'agent';
type MessageKind = ParticipantKind | 'system' | 'developer';
export type Presence = 'online' | 'working' | 'needs-login' | 'failed' | 'stopped' | 'idle';
export type AgentActivityPhase = 'reading' | 'thinking' | 'speaking' | 'tooling' | 'writing';

export interface AgentActivityOverride {
  phase: AgentActivityPhase;
  expiresAt: number;
}

export interface Participant {
  id: string;
  av: string;
  icon?: WorkspaceExperienceIcon;
  avatarUrl?: string;
  name: string;
  kind: ParticipantKind;
  tag: string;
  role?: string;
  presence: Presence;
  activityPhase?: AgentActivityPhase;
  metadata?: {
    agent?: string;
    model?: string;
    effort?: string;
    speed?: 'standard' | 'fast' | string;
    autopilot?: boolean;
  };
}

export type Project = WorkspaceExperienceProject;

interface ToolChip {
  label: string;
}

export interface Message {
  id: string;
  renderKey?: string;
  authorId: string;
  authorName: string;
  av: string;
  icon?: Participant['icon'];
  avatarUrl?: string;
  kind: MessageKind;
  tag: string;
  time: string;
  text: string;
  agentChip?: {
    id: string;
    name: string;
    icon?: Participant['icon'];
    avatarUrl?: string;
    tag: string;
  };
  fanoutAgents?: Array<{
    id: string;
    name: string;
    icon?: Participant['icon'];
    avatarUrl?: string;
    tag: string;
  }>;
  nativeCliSessionId?: string;
  deliveryId?: NativeAgentDeliveryId;
  developerOnly?: boolean;
  systemTone?: 'error' | 'pending';
  systemDetail?: string;
  systemRaw?: unknown;
  reasoning?: string;
  streaming?: boolean;
  orderKey?: string;
  internals?: ToolChip[];
  attachments?: MessageAttachment[];
  localStatus?: 'sending' | 'sent' | 'failed';
  retrySend?: () => void;
}

export type MessageAttachment = MessageAttachmentRef;

export interface TypingIndicator {
  av: string;
  icon?: Participant['icon'];
  avatarUrl?: string;
  name: string;
  detail: string;
}

export interface ProjectMentionTarget {
  id: string;
  name: string;
}

export type ActivityStatus = 'running' | 'ok' | 'error';

export interface ActivityRow {
  id: string;
  av: string;
  agentName?: string;
  tool: string;
  detail: string;
  output?: string;
  status: ActivityStatus;
}

export interface AgentTask {
  id: string;
  av: string;
  title: string;
  output?: string;
  status: ActivityStatus;
}

export interface NativeCliStreamView {
  id: string;
  agentName: string;
  agentAliases?: string[];
  templateAgentName?: string;
  provider: string;
  tag: string;
  icon?: Participant['icon'];
  status: ActivityStatus;
  workingPath?: string;
  observedAt?: string;
  output: string;
  items: NativeCliObservationEvent[];
}

export interface ApprovalView {
  id: string;
  nativeCliSessionId?: string;
  approvalOwnership?: 'provider-owned';
  av: string;
  name: string;
  tag: string;
  tool: string;
  text: string;
  meta: string;
}

export interface QuestionView {
  id: string;
  askerName: string;
  question: string;
  options: string[];
  mode: 'single' | 'multiple';
  allowOther: boolean;
}

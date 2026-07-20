import type {
  MessageAttachmentRef,
  NativeAgentDeliveryId,
  MessageAttachment as ProtocolMessageAttachment
} from '@monad/protocol';
import type { WorkspaceExperienceIcon, WorkspaceExperienceProject } from '@monad/sdk-experience';
import type { AgentObservationCard } from '../../agent-adapters/observation-cards.ts';

export type { WorkspaceExperienceProductIconId } from '@monad/sdk-experience';
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
  meshSessionId?: string;
  deliveryId?: NativeAgentDeliveryId;
  developerOnly?: boolean;
  systemTone?: 'error';
  systemDetail?: string;
  systemRaw?: unknown;
  systemActions?: Array<{ actionId: string; payload?: unknown }>;
  /** A DM's content never leaves the two participants' own provider context — the room only
   *  ever sees that a DM happened, not what it said. */
  directMessage?: {
    fromAgentName: string;
    toAgentName: string;
  };
  reasoning?: string;
  streaming?: boolean;
  orderKey?: string;
  internals?: ToolChip[];
  attachments?: MessageAttachment[];
  localStatus?: 'sending' | 'sent' | 'failed';
  retrySend?: () => void;
}

export type MessageAttachment = ProtocolMessageAttachment;

export function isMessageAttachmentRef(attachment: MessageAttachment): attachment is MessageAttachmentRef {
  return attachment.path !== undefined;
}

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

export interface MeshAgentStreamView {
  id: string;
  /** The session/project transcript the MeshAgent session belongs to. Observation and
   *  history requests must be scoped to THIS id — the room's currently active session can be a
   *  different session of the same project, and the daemon rejects the mismatch (404). */
  transcriptTargetId?: string;
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
  items: AgentObservationCard[];
}

export interface ApprovalView {
  id: string;
  meshSessionId?: string;
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

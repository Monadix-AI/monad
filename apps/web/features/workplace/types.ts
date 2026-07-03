import type { MessageAttachmentRef, NativeAgentDeliveryId, NativeCliObservationEvent } from '@monad/protocol';
import type { ProductIconId } from '@monad/ui';

// UI view-model types for the workplace surface. These are render shapes the components
// consume; use-project.ts derives them from the real monad session backend (stream
// messages, tool steps, pending approvals, configured ACP agents). No mock data
// lives here — only types and small static UI config.

export type ParticipantKind = 'human' | 'agent';
type MessageKind = ParticipantKind | 'system' | 'developer';
export type Presence = 'online' | 'working' | 'needs-login' | 'failed' | 'stopped' | 'idle';
export type AgentActivityPhase = 'reading' | 'thinking' | 'speaking';
export interface AgentActivityOverride {
  phase: AgentActivityPhase;
  expiresAt: number;
}

export interface Participant {
  id: string;
  /** Avatar initials, e.g. "MO". */
  av: string;
  /** Official product mark for provider-owned or Monad participants. */
  icon?: 'monad' | ProductIconId | 'openai' | 'anthropic' | 'google';
  avatarUrl?: string;
  name: string;
  kind: ParticipantKind;
  /** Short label badge — User / AI / ACP. */
  tag: string;
  /** Sub-label in the roster, e.g. "supervisor", "agent". */
  role?: string;
  presence: Presence;
  activityPhase?: AgentActivityPhase;
}

/** Workplace Project list item shown in the supervisor's multi-agent project rail. */
export interface Project {
  id: string;
  name: string;
  unread?: number;
  active?: boolean;
}

/** Agent-internal activity surfaced under an assistant bubble (live tool steps). */
interface ToolChip {
  label: string;
}

export interface Message {
  id: string;
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
  systemTone?: 'error';
  systemDetail?: string;
  systemRaw?: unknown;
  reasoning?: string;
  streaming?: boolean;
  orderKey?: string;
  internals?: ToolChip[];
  /** Structured references to local files shared for human reading (reports, spilled long bodies). */
  attachments?: MessageAttachment[];
}

/** Reference to a file on the daemon host — content stays in the file and is read on demand.
 *  Aliased to the wire schema so the UI type can never drift from what the daemon emits. */
export type MessageAttachment = MessageAttachmentRef;

/** Live "is working" footer row, shown while the agent is streaming a reply. */
export interface TypingIndicator {
  av: string;
  icon?: Participant['icon'];
  avatarUrl?: string;
  name: string;
  detail: string;
}

export type ActivityStatus = 'running' | 'ok' | 'error';

/** One real tool step from the session event stream. */
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
  templateAgentName?: string;
  provider: string;
  tag: string;
  icon?: Participant['icon'];
  status: ActivityStatus;
  workingPath?: string;
  output: string;
  items: NativeCliObservationEvent[];
}

/** A real pending tool approval from the oversight gate. */
export interface ApprovalView {
  /** requestId — passed back to approveTool. */
  id: string;
  nativeCliSessionId?: string;
  approvalOwnership?: 'provider-owned';
  av: string;
  /** Agent that requested (display). */
  name: string;
  tag: string;
  /** Tool name, e.g. "agent_acp_delegate". */
  tool: string;
  /** Short human summary of what it wants to do. */
  text: string;
  /** Mono sub-line (gate key / tool). */
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

const _PROJECT_TABS = [
  { key: 'chat', label: 'Chat', badge: null as string | null },
  { key: 'activity', label: 'Activity', badge: null as string | null }
] as const;

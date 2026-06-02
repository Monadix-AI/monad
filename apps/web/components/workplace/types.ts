// UI view-model types for the workplace surface. These are render shapes the components
// consume; use-project.ts derives them from the real monad session backend (stream
// messages, tool steps, pending approvals, configured ACP agents). No mock data
// lives here — only types and small static UI config.

export type ParticipantKind = 'human' | 'agent';
export type Presence = 'online' | 'working' | 'idle';

export interface Participant {
  id: string;
  /** Avatar initials, e.g. "MO". */
  av: string;
  /** Official product mark for provider-owned or Monad participants. */
  icon?: 'monad' | 'openai' | 'anthropic';
  name: string;
  kind: ParticipantKind;
  /** Short label badge — User / AI / ACP. */
  tag: string;
  /** Sub-label in the roster, e.g. "supervisor", "agent". */
  role?: string;
  presence: Presence;
}

/** A project = a monad session. Projects list the supervisor's multi-agent sessions. */
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
  kind: ParticipantKind;
  tag: string;
  time: string;
  text: string;
  reasoning?: string;
  streaming?: boolean;
  internals?: ToolChip[];
}

/** Live "is working" footer row, shown while the agent is streaming a reply. */
export interface TypingIndicator {
  av: string;
  icon?: Participant['icon'];
  name: string;
  detail: string;
}

export type ActivityStatus = 'running' | 'ok' | 'error';

/** One real tool step from the session event stream. */
export interface ActivityRow {
  id: string;
  av: string;
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

export const PROJECT_TABS = [
  { key: 'chat', label: 'Chat', badge: null as string | null },
  { key: 'activity', label: 'Activity', badge: null as string | null }
] as const;

export type ProjectTabKey = (typeof PROJECT_TABS)[number]['key'];

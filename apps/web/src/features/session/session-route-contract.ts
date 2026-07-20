import type {
  ApprovalScope,
  CommandItem,
  ComposerSettings,
  Session,
  SessionId,
  UIApprovalDisplay,
  UIItem
} from '@monad/protocol';
import type { VirtualListHandle } from '@monad/ui/components/VirtualList';
import type { ComponentProps, KeyboardEventHandler, RefObject } from 'react';
import type { ComposerShell } from './ComposerShell';
import type { ViewItem } from './chat-view-items';
import type { SessionCommandMenuItem } from './command-menu';

export const SESSION_ROUTE_MODEL_REGIONS = ['identity', 'transcript', 'composer', 'inspector'] as const;
export type SessionTranscriptRenderMode = 'detail' | 'summary';

export interface PendingApproval {
  display?: UIApprovalDisplay;
  input?: unknown;
  key?: string;
  requestId: string;
  tool: string;
}

interface PendingClarification {
  options?: string[];
  question: string;
  requestId: string;
}

type ComposerProps = ComponentProps<typeof ComposerShell>;

export interface SessionIdentityModel {
  assistantLabel: string;
  currentSession: Session | null;
  currentSessionId: SessionId;
  isArchived: boolean;
  isDeleted: boolean;
  isDraft: boolean;
  isReadOnly: boolean;
  isUnarchiving: boolean;
  onRetryDraftSession?: () => void;
  onSelectSession: (sessionId: SessionId) => void;
  onUnarchive: () => void;
}

export interface SessionTranscriptModel {
  highlightedMessageId: string | null;
  isLoading: boolean;
  showLoadingSkeleton: boolean;
  onApproval: (approval: PendingApproval, allow: boolean, scope: ApprovalScope, reason?: string) => void;
  onBranch: (messageId: string) => void;
  onClarifyAnswer: (requestId: string, answer: string) => void;
  onEndReached: () => void;
  onHighlightedMessageResolved?: (messageId: string) => void;
  onRestore: (messageId: string, text: string) => Promise<boolean>;
  onScrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  onStartReached: () => void;
  pendingApprovals: PendingApproval[];
  pendingClarifications: PendingClarification[];
  transcriptRef: RefObject<VirtualListHandle | null>;
  viewMessages: ViewItem[];
}

export interface SessionComposerModel {
  commandMenuLoading: boolean;
  composerSettings: ComposerSettings;
  contextUsage?: ComposerProps['contextUsage'];
  isBusy: boolean;
  menuItems: SessionCommandMenuItem[];
  messageQueue: string[];
  model: ComposerProps['model'];
  onCancelQueued: () => void;
  onCommandItemApply: (item: SessionCommandMenuItem) => void;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  onRemoveQueuedMessage: (index: number) => void;
  onSteerQueued: () => void;
  onStop: () => void;
  onSubmit: () => void;
  onVoiceSettingsClick: () => void;
  onVoiceTranscribe: (audio: Blob) => Promise<string>;
  skillMenuOpen: boolean;
  voiceModelConfigured: boolean;
}

export interface SessionInspectorModel {
  items: UIItem[];
}

export interface SessionRouteModel {
  commands: CommandItem[];
  composer: SessionComposerModel;
  identity: SessionIdentityModel;
  inspector: SessionInspectorModel;
  transcript: SessionTranscriptModel;
}

export function sessionIsDraft(session: Session | null): boolean {
  const ext = session?.origin?.ext;
  return Boolean(ext && typeof ext === 'object' && 'draft' in ext && ext.draft === true);
}

/** Project sessions use the channel endpoint so messages fan out to their invited members. */
export function sessionUsesProjectMessageRoute(session: Pick<Session, 'projectId'>): boolean {
  return session.projectId !== null && session.projectId !== undefined;
}

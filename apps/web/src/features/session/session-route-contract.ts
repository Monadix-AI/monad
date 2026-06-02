import type {
  ApprovalScope,
  ClarifyAsker,
  ClarifyForm,
  ClarifyRespondRequest,
  CommandItem,
  ComposerSettings,
  SendMessageAttachment,
  Session,
  SessionId,
  UIApprovalDisplay,
  UIItem,
  UIMessageOutlineItem,
  UrlElicitation
} from '@monad/protocol';
import type { VirtualListHandle } from '@monad/ui/components/VirtualList';
import type { ComponentProps, KeyboardEventHandler, RefObject } from 'react';
import type { Msg } from './ChatMessage';
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

export interface PendingClarification {
  asker?: ClarifyAsker;
  form?: ClarifyForm;
  options?: string[];
  question: string;
  requestId: string;
  urlElicitation?: UrlElicitation;
}

type ComposerProps = ComponentProps<typeof ComposerShell>;

export interface SessionQueuedMessage {
  attachments?: SendMessageAttachment[];
  replyGeneration?: number;
  replyToMessageId?: string;
  text: string;
}

export function sessionMessagesCanSteer(queue: readonly SessionQueuedMessage[]): boolean {
  return queue.length > 0 && queue.every((item) => item.replyToMessageId === undefined && !item.attachments?.length);
}

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
  messageOutline: UIMessageOutlineItem[];
  showLoadingSkeleton: boolean;
  onApproval: (approval: PendingApproval, allow: boolean, scope: ApprovalScope, reason?: string) => void;
  onBranch: (messageId: string) => void;
  onClarifyAnswer: (requestId: string, response: Omit<ClarifyRespondRequest, 'requestId'>) => void;
  onEndReached: () => void;
  onHighlightedMessageResolved?: (messageId: string) => void;
  onOpenMessage: (messageId: string) => void;
  onReply: (messageId: string) => void;
  onRestore: (messageId: string, text: string) => Promise<boolean>;
  onScrollToBottom: (behavior?: 'smooth' | 'auto') => void;
  onStartReached: () => void;
  pendingApprovals: PendingApproval[];
  pendingClarifications: PendingClarification[];
  transcriptRef: RefObject<VirtualListHandle | null>;
  replyTargets: ReadonlyMap<string, Msg | null>;
  viewMessages: ViewItem[];
}

export interface SessionComposerModel {
  attachmentError: 'open' | 'read' | null;
  attachments: NonNullable<ComposerProps['attachments']>;
  commandMenuLoading: boolean;
  composerSettings: ComposerSettings;
  contextUsage?: ComposerProps['contextUsage'];
  isBusy: boolean;
  menuItems: SessionCommandMenuItem[];
  messageQueue: SessionQueuedMessage[];
  model: ComposerProps['model'];
  onAttachFiles: NonNullable<ComposerProps['onAttachFiles']>;
  onCancelQueued: () => void;
  onCommandItemApply: (item: SessionCommandMenuItem) => void;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  onRemoveQueuedMessage: (index: number) => void;
  onCancelReply: () => void;
  onOpenReplyTarget: () => void;
  onOpenAttachment: NonNullable<ComposerProps['onOpenAttachment']>;
  onRemoveAttachment: NonNullable<ComposerProps['onRemoveAttachment']>;
  onSteerQueued: () => void;
  onStop: () => void;
  onSubmit: () => void;
  onVoiceSettingsClick: () => void;
  onVoiceTranscribe: (audio: Blob) => Promise<string>;
  skillMenuOpen: boolean;
  replyTarget: Msg | null;
  replyTargetId: string | null;
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
  return session?.isDraft === true;
}

/** Project sessions use the channel endpoint so messages fan out to their invited members. */
export function sessionUsesProjectMessageRoute(session: Pick<Session, 'projectId'>): boolean {
  return session.projectId !== null && session.projectId !== undefined;
}

export function resolveSessionComposerReplyTarget({
  assistantLabel,
  replyTargetId,
  viewMessages,
  youLabel
}: {
  assistantLabel: string;
  replyTargetId: string | null;
  viewMessages: readonly ViewItem[];
  youLabel: string;
}): Msg | null {
  if (!replyTargetId) return null;
  const target = viewMessages.find((item): item is Msg => 'role' in item && item.id === replyTargetId);
  if (!target) return null;
  return {
    ...target,
    label: target.label ?? (target.role === 'user' ? youLabel : assistantLabel)
  };
}

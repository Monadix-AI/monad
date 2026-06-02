import type { ComposerSendShortcut, ContextUsagePayload, ProfileView, SendMessageAttachment } from '@monad/protocol';
import type { WorkplaceApprovalDecision } from '@monad/sdk-experience';
import type {
  ApprovalView,
  Participant,
  ProjectMentionTarget,
  QuestionView,
  TypingIndicator
} from '../../experience/types.ts';

export type ProjectComposerDirective =
  | string
  | { attachments?: SendMessageAttachment[]; replyGeneration?: number; replyToMessageId?: string; text: string };

export type ProjectComposerSurface = {
  answerQuestion: (requestId: string, answer: string) => void;
  approvals: ApprovalView[];
  busy: boolean;
  contextUsage?: ContextUsagePayload | null;
  draftKey: string;
  mentionTargets: ProjectMentionTarget[];
  modelProfiles: ProfileView[];
  participants: Participant[];
  pauseAll: () => void;
  questions: QuestionView[];
  resolveApproval: (requestId: string, action: WorkplaceApprovalDecision) => void;
  sendDirective: (directive: ProjectComposerDirective) => Promise<void> | void;
  replyTarget?: import('../../experience/types.ts').Message | null;
  replyToMessageId?: string;
  replyGeneration?: number;
  cancelReply?: () => void;
  openReplyTarget?: () => void;
  sendShortcut?: ComposerSendShortcut;
  typing: TypingIndicator | null;
};

type ProjectComposerSource = Omit<ProjectComposerSurface, 'typing'>;

export function toProjectComposerSurface(
  c: ProjectComposerSource,
  typing: TypingIndicator | null
): ProjectComposerSurface {
  return {
    answerQuestion: c.answerQuestion,
    approvals: c.approvals,
    busy: c.busy,
    contextUsage: c.contextUsage,
    draftKey: c.draftKey,
    mentionTargets: c.mentionTargets,
    modelProfiles: c.modelProfiles,
    participants: c.participants,
    pauseAll: c.pauseAll,
    questions: c.questions,
    resolveApproval: c.resolveApproval,
    sendDirective: c.sendDirective,
    replyTarget: c.replyTarget,
    replyToMessageId: c.replyToMessageId,
    replyGeneration: c.replyGeneration,
    cancelReply: c.cancelReply,
    openReplyTarget: c.openReplyTarget,
    sendShortcut: c.sendShortcut,
    typing
  };
}

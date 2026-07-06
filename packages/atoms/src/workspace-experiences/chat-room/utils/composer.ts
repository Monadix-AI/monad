import type {
  ComposerFollowUpBehavior,
  ComposerSendShortcut,
  ContextUsagePayload,
  ProfileView,
  SendMessageAttachment
} from '@monad/protocol';
import type {
  ApprovalView,
  Participant,
  ProjectMentionTarget,
  QuestionView,
  TypingIndicator
} from '../../experience/types.ts';

export type ProjectComposerDirective = string | { attachments?: SendMessageAttachment[]; text: string };

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
  resolveApproval: (requestId: string, action: 'approve' | 'reject') => void;
  sendDirective: (directive: ProjectComposerDirective) => Promise<void> | void;
  sendShortcut?: ComposerSendShortcut;
  followUpBehavior?: ComposerFollowUpBehavior;
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
    sendShortcut: c.sendShortcut,
    followUpBehavior: c.followUpBehavior,
    typing
  };
}

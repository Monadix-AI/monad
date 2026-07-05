import type { ContextUsagePayload, ProfileView } from '@monad/protocol';
import type {
  ApprovalView,
  Participant,
  ProjectMentionTarget,
  QuestionView,
  TypingIndicator
} from '../../experience/types.ts';

export type ProjectComposerSurface = {
  answerQuestion: (requestId: string, answer: string) => void;
  approvals: ApprovalView[];
  contextUsage?: ContextUsagePayload | null;
  mentionTargets: ProjectMentionTarget[];
  modelProfiles: ProfileView[];
  participants: Participant[];
  pauseAll: () => void;
  questions: QuestionView[];
  resolveApproval: (requestId: string, action: 'approve' | 'reject') => void;
  sendDirective: (text: string) => Promise<void> | void;
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
    contextUsage: c.contextUsage,
    mentionTargets: c.mentionTargets,
    modelProfiles: c.modelProfiles,
    participants: c.participants,
    pauseAll: c.pauseAll,
    questions: c.questions,
    resolveApproval: c.resolveApproval,
    sendDirective: c.sendDirective,
    typing
  };
}

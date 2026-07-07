import type {
  AvatarStyle,
  ComposerFollowUpBehavior,
  ComposerSendShortcut,
  ExternalAgentSessionView,
  ProfileView,
  UIItem
} from '@monad/protocol';
import type { ProjectMember } from './project-members.ts';
import type { Message, Participant } from './types.ts';

export interface ProjectExperienceCanvasSource {
  projectId: string;
  ready: boolean;
  participants: Participant[];
  projectMembers: ProjectMember[];
  source: {
    transcriptItems: readonly UIItem[];
    liveItems: readonly UIItem[];
    liveTools?: readonly Extract<UIItem, { kind: 'tool' }>[];
    externalAgentSessions: ExternalAgentSessionView[];
    human: Participant;
    externalAgentAvatarSeeds: Map<string, string>;
    externalAgentTags: Map<string, string>;
    externalAgentDisplayNames: Map<string, string>;
    externalAgentIcons?: Map<string, Message['icon']>;
    avatarStyle?: AvatarStyle;
    showDeveloperOnlyMessages: boolean;
  };
  modelProfiles: ProfileView[];
  sendShortcut?: ComposerSendShortcut;
  followUpBehavior?: ComposerFollowUpBehavior;
  loadOlder: () => void;
  sendDirective: import('../chat-room/utils/composer.ts').ProjectComposerSurface['sendDirective'];
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: () => void;
  sendExternalAgentInput: (id: string, input: string) => Promise<void>;
  stopExternalAgent: (id: string) => Promise<void>;
}

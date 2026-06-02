import type {
  AvatarStyle,
  ComposerSendShortcut,
  MeshSessionView,
  MessageId,
  ProfileView,
  SessionId,
  UIItem,
  UIMessageItem,
  UIMessageOutlineItem
} from '@monad/protocol';
import type { WorkplaceApprovalDecision } from '@monad/sdk-experience';
import type { MeshAgentExperienceInput } from './mesh-agent-state.ts';
import type { ProjectMember } from './project-members.ts';
import type { Message, Participant } from './types.ts';

export interface ProjectExperienceCanvasSource {
  projectId: string;
  /** The project's currently-active session (Track B: a project's own id is no longer a
   *  conversation id — mesh-agent observation/history/input targets this instead). Null while
   *  the session is still resolving/being created. */
  activeSessionId: SessionId | null;
  ready: boolean;
  participants: Participant[];
  projectMembers: ProjectMember[];
  source: {
    transcriptItems: readonly UIItem[];
    liveItems: readonly UIItem[];
    liveTools?: readonly Extract<UIItem, { kind: 'tool' }>[];
    meshSessions: MeshSessionView[];
    meshAgentState?: MeshAgentExperienceInput;
    human: Participant;
    meshAgentAvatarSeeds: Map<string, string>;
    meshAgentTags: Map<string, string>;
    meshAgentDisplayNames: Map<string, string>;
    meshAgentIcons?: Map<string, Message['icon']>;
    avatarStyle?: AvatarStyle;
    showDeveloperOnlyMessages: boolean;
  };
  modelProfiles: ProfileView[];
  sendShortcut?: ComposerSendShortcut;
  loadOlder: () => void;
  loadNewer: () => void;
  jumpToLive: () => void;
  transcriptMode: 'history' | 'live';
  messageOutline?: readonly UIMessageOutlineItem[];
  openAtMessage?: (messageId: MessageId, options?: { targetVisible?: boolean }) => Promise<boolean>;
  replyTargets?: ReadonlyMap<string, UIMessageItem | null>;
  sendDirective: import('../chat-room/utils/composer.ts').ProjectComposerSurface['sendDirective'];
  resolveApproval: (requestId: string, decision: WorkplaceApprovalDecision) => void;
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: () => void;
  sendMeshAgentInput: (id: string, input: string) => Promise<void>;
  stopMeshAgent: (id: string) => Promise<void>;
}

import type { AvatarStyle, NativeCliSessionView, ProfileView, UIItem } from '@monad/protocol';
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
    nativeCliSessions: NativeCliSessionView[];
    human: Participant;
    nativeCliAvatarSeeds: Map<string, string>;
    nativeCliTags: Map<string, string>;
    nativeCliDisplayNames: Map<string, string>;
    nativeCliIcons?: Map<string, Message['icon']>;
    avatarStyle?: AvatarStyle;
    showDeveloperOnlyMessages: boolean;
  };
  modelProfiles: ProfileView[];
  loadOlder: () => void;
  sendDirective: (text: string) => Promise<void> | void;
  resolveApproval: (requestId: string, decision: 'approve' | 'reject') => void;
  answerQuestion: (requestId: string, answer: string) => void;
  pauseAll: () => void;
  sendNativeCliInput: (id: string, input: string) => Promise<void>;
  stopNativeCli: (id: string) => Promise<void>;
}

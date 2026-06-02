import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { ReactElement } from 'react';
import type { TFn } from '@/components/I18nProvider';
import type { ActivityRow, AgentTask, Message, Participant, TypingIndicator } from '../types';

// A preset is pure presentation: the read-only mapping of chatroom data → UI. It never owns
// management (members/moderator/approvals/workdir) or primary communication (the composer) — those
// are host-rendered and identical across presets. `ProjectCanvas` is the narrowed surface the host
// hands a preset; it carries display data only, plus the two host-provided live-agent callbacks the
// activity view surfaces inline (the preset renders the affordance, the host owns the function).
export interface ProjectCanvas {
  ready: boolean;
  messages: Message[];
  participants: Participant[];
  activity: ActivityRow[];
  tasks: AgentTask[];
  typing: TypingIndicator | null;
  firstItemIndex: number;
  loadOlder: () => void;
  sendNativeCliInput: (id: string, input: string) => Promise<void>;
  stopNativeCli: (id: string) => Promise<void>;
}

export interface ProjectView {
  canvas: ProjectCanvas;
  t: TFn;
  embedded: boolean;
}

type PresetComponent = (view: ProjectView) => ReactElement;

export interface PresetDefinition {
  // 'chat' | 'graph' | 'atom:<pack>:<id>'
  id: string;
  // i18n key for the switcher label.
  labelKey: WebMessageIdWithoutParams;
  icon?: string;
  source: 'builtin' | 'atom';
  atomName?: string;
  render: PresetComponent;
}

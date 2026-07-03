import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { WorkspaceExperienceDefinition } from '@monad/protocol';
import type { ReactElement } from 'react';
import type { TFn } from '@/components/I18nProvider';
import type { ChatRoomCanvas } from './chat-room/canvas';
import type { ProjectExperienceActions, ProjectExperienceSnapshot } from './contracts';
import type { GraphicViewCanvas } from './graphic-view/canvas';
import type { ProjectComposerSurface } from './shared/composer';

interface ChatRoomExperienceRuntime {
  canvas: ChatRoomCanvas;
}

interface GraphicViewExperienceRuntime {
  canvas: GraphicViewCanvas;
}

export interface ProjectExperienceRuntime {
  chatRoom: ChatRoomExperienceRuntime;
  composer: ProjectComposerSurface;
  graphicView: GraphicViewExperienceRuntime;
  host: ProjectExperienceSnapshot;
  snapshot: ProjectExperienceSnapshot;
  actions: ProjectExperienceActions;
}

export interface ProjectExperienceView {
  embedded: boolean;
  onProjectSettingsOpenChange?: (open: boolean) => void;
  projectSettingsOpen: boolean;
  runtime: ProjectExperienceRuntime;
  t: TFn;
}

type ProjectExperienceComponent = (view: ProjectExperienceView) => ReactElement;

export interface ProjectExperienceDefinition {
  id: string;
  label?: string;
  labelKey?: WebMessageIdWithoutParams;
  icon?: string;
  source: 'builtin' | 'atom';
  atomName?: string;
  atom?: WorkspaceExperienceDefinition;
  render: ProjectExperienceComponent;
}

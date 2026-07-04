import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { ReactElement } from 'react';

interface ProjectExperienceHostRuntime {
  actions: unknown;
  snapshot: unknown;
}

export interface ProjectExperienceView {
  embedded: boolean;
  onProjectSettingsOpenChange?: (open: boolean) => void;
  projectSettingsOpen: boolean;
  runtime: ProjectExperienceHostRuntime;
  voiceModelState?: 'checking' | 'configured' | 'missing' | 'failed';
}

type ProjectExperienceComponent = (view: ProjectExperienceView) => ReactElement;

export interface ProjectExperienceDefinition {
  id: string;
  label?: string;
  labelKey?: WebMessageIdWithoutParams;
  icon?: string;
  render: ProjectExperienceComponent;
}

import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';
import type { WorkplaceExperienceProjectDialogRequest } from '@monad/protocol';
import type { WorkplaceExperienceActions, WorkplaceExperienceSnapshot } from '@monad/sdk-experience';
import type { ReactElement } from 'react';

interface ProjectExperienceHostRuntime {
  actions: WorkplaceExperienceActions;
  snapshot: WorkplaceExperienceSnapshot;
}

export interface ProjectExperienceView {
  embedded: boolean;
  onProjectDialogRequest?: (request: WorkplaceExperienceProjectDialogRequest) => void;
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

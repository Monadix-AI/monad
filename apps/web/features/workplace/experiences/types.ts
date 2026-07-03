import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { WorkspaceExperienceDefinition } from '@monad/protocol';
import type { ReactElement } from 'react';
import type { TFn } from '@/components/I18nProvider';
import type { ProjectCanvas } from '../presets/types';
import type { ProjectController } from '../use-project';

interface ProjectExperienceSnapshot extends ProjectCanvas {
  projectId: string;
  activeProjectId: ProjectController['activeProjectId'];
  projects: ProjectController['projects'];
  railAgents: ProjectController['railAgents'];
  projectMembers: ProjectController['projectMembers'];
  availableProjectMembers: ProjectController['availableProjectMembers'];
  nativeCliStreams: ProjectController['nativeCliStreams'];
  contextUsage: ProjectController['contextUsage'];
  modelProfiles: ProjectController['modelProfiles'];
  approvals: ProjectController['approvals'];
  workdir: ProjectController['workdir'];
  paused: ProjectController['paused'];
  mentionTargets: ProjectController['mentionTargets'];
}

interface ProjectExperienceActions {
  loadOlder: ProjectController['loadOlder'];
  sendDirective: ProjectController['sendDirective'];
  resolveApproval: ProjectController['resolveApproval'];
  approveAll: ProjectController['approveAll'];
  pauseAll: ProjectController['pauseAll'];
  addProjectMember: ProjectController['addProjectMember'];
  removeProjectMember: ProjectController['removeProjectMember'];
  updateProjectMemberSettings: ProjectController['updateProjectMemberSettings'];
  sendNativeCliInput: ProjectController['sendNativeCliInput'];
  stopNativeCli: ProjectController['stopNativeCli'];
  switchExperience: (id: string) => void;
}

export interface ProjectExperienceRuntime {
  snapshot: ProjectExperienceSnapshot;
  actions: ProjectExperienceActions;
}

export interface ProjectExperienceView {
  embedded: boolean;
  onProjectSettingsOpenChange?: (open: boolean) => void;
  project: ProjectController;
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

import type { ExternalAgentAppServerTransport } from '@monad/protocol';
import type { ProjectController } from '../use-project';

type AvailableProjectMember = ProjectController['availableProjectMembers'][number];
type ProjectMember = ProjectController['projectMembers'][number];

export type ExternalAgentDraft = {
  displayName?: string;
  projectTemplateId?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  appServerTransport?: ExternalAgentAppServerTransport;
  customPrompt?: string;
};

export type ExternalAgentMemberDialogState = {
  candidate: AvailableProjectMember;
  draft: ExternalAgentDraft;
  editingMemberId?: string;
};

export function externalAgentMemberDialogStateForMember(
  room: ProjectController,
  member: ProjectMember
): ExternalAgentMemberDialogState | null {
  if (member.type !== 'external-agent') return null;
  const templateName = member.templateName ?? member.name;
  const candidate = room.availableProjectMembers.find(
    (option) =>
      option.type === 'external-agent' &&
      option.name === templateName &&
      (!member.projectTemplateId || option.template?.id === member.projectTemplateId)
  );
  if (!candidate) return null;
  const settings = member.settings ?? {};
  return {
    candidate,
    editingMemberId: member.id,
    draft: {
      displayName: member.displayName ?? member.name,
      projectTemplateId: member.projectTemplateId,
      modelId: settings.modelId,
      reasoningEffort: settings.reasoningEffort,
      speed: settings.speed,
      appServerTransport: settings.appServerTransport,
      customPrompt: settings.customPrompt
    }
  };
}

export function externalAgentModelDisplayName(modelName: string): string {
  if (modelName.startsWith('gpt-')) {
    return modelName
      .split('-')
      .map((part, index) => (index === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('-');
  }
  if (modelName.startsWith('claude-')) {
    return modelName
      .replace(/^claude-/, '')
      .replace(/-(\d)-(\d)$/, ' $1.$2')
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return modelName;
}

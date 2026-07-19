import type { ProjectController } from '../use-project';

type AvailableProjectMember = ProjectController['availableProjectMembers'][number];
type ProjectMember = ProjectController['projectMembers'][number];

export type MeshAgentDraft = {
  displayName?: string;
  projectTemplateId?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  customPrompt?: string;
};

export type MeshAgentMemberDialogState = {
  candidate: AvailableProjectMember;
  draft: MeshAgentDraft;
  editingMemberId?: string;
};

export function meshAgentMemberDialogStateForMember(
  room: ProjectController,
  member: ProjectMember
): MeshAgentMemberDialogState | null {
  if (member.type !== 'mesh-agent') return null;
  const templateName = member.templateName ?? member.name;
  const candidate = room.availableProjectMembers.find(
    (option) =>
      option.type === 'mesh-agent' &&
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
      customPrompt: settings.customPrompt
    }
  };
}

export function meshAgentModelDisplayName(modelName: string): string {
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

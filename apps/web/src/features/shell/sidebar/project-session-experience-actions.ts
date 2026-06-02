import type { TreeItemMenuAction } from './workspace-tree-item';

import { Layers01Icon, MessageSquareCodeIcon, NeuralNetworkIcon } from '@hugeicons/core-free-icons';

export function projectExperienceAction(args: {
  activeExperienceId: string;
  experiences: Array<{ icon?: string; id: string; label: string }>;
  label: string;
  onSelect: (id: string) => void;
}): TreeItemMenuAction | null {
  if (args.experiences.length === 0) return null;
  return {
    icon: Layers01Icon,
    label: args.label,
    items: args.experiences.map((experience) => ({
      checked: experience.id === args.activeExperienceId,
      icon: experience.icon === 'git-fork' ? NeuralNetworkIcon : MessageSquareCodeIcon,
      label: experience.label,
      onSelect: () => args.onSelect(experience.id),
      value: experience.id
    }))
  };
}

import type { UIItem } from '@monad/protocol';
import type { Participant } from '../../experience/types.ts';
import type { WorkspaceExperienceGraphCanvas } from './graph-model.ts';

import { activityRowsFromTools } from '../../shared/utils/activity.ts';

export function toGraphicViewCanvas(args: {
  participants: Participant[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
}): WorkspaceExperienceGraphCanvas {
  return {
    participants: args.participants,
    activity: activityRowsFromTools(args.liveTools)
  };
}

import type { UIItem } from '@monad/protocol';
import type { WorkspaceExperienceGraphCanvas } from '@monad/sdk-experience';
import type { Participant } from './types.ts';

import { activityRowsFromTools } from '../shared/utils/activity.ts';

/** Framework-neutral projection published to any workspace experience that consumes graphCanvas. */
export function toWorkspaceExperienceGraphCanvas(args: {
  participants: Participant[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
}): WorkspaceExperienceGraphCanvas {
  return {
    participants: args.participants,
    activity: activityRowsFromTools(args.liveTools)
  };
}

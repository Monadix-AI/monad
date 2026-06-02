import type { UIItem } from '@monad/protocol';
import type { WorkplaceExperienceGraphCanvas } from '@monad/sdk-experience';
import type { Participant } from './types.ts';

import { activityRowsFromTools } from '../shared/utils/activity.ts';

/** Framework-neutral projection published to any workplace experience that consumes graphCanvas. */
export function toWorkplaceExperienceGraphCanvas(args: {
  participants: Participant[];
  liveTools: readonly Extract<UIItem, { kind: 'tool' }>[];
}): WorkplaceExperienceGraphCanvas {
  return {
    participants: args.participants,
    activity: activityRowsFromTools(args.liveTools)
  };
}

import type { ActivityRow, Participant } from '../../types';
import type { ProjectController } from '../../use-project';

import { activityRowsFromTools } from '../shared/activity';

export interface GraphicViewCanvas {
  participants: Participant[];
  activity: ActivityRow[];
}

export function toGraphicViewCanvas(c: ProjectController): GraphicViewCanvas {
  return {
    participants: c.participants,
    activity: activityRowsFromTools(c.source.liveTools)
  };
}

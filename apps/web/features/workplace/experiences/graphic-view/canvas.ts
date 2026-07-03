import type { ActivityRow, Participant } from '../../types';

import { activityRowsFromTools } from '../shared/activity';

export interface GraphicViewCanvas {
  participants: Participant[];
  activity: ActivityRow[];
}

interface GraphicViewCanvasSource {
  participants: Participant[];
  source: {
    liveTools: Parameters<typeof activityRowsFromTools>[0];
  };
}

export function toGraphicViewCanvas(c: GraphicViewCanvasSource): GraphicViewCanvas {
  return {
    participants: c.participants,
    activity: activityRowsFromTools(c.source.liveTools)
  };
}

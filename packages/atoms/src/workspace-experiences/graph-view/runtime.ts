import type { ProjectExperienceCanvasSource } from '../experience/source.ts';
import type { WorkspaceExperienceGraphCanvas } from './utils/graph-model.ts';

import { toGraphicViewCanvas } from './utils/canvas.ts';

export interface GraphicViewExperienceRuntime {
  canvas: WorkspaceExperienceGraphCanvas;
}

export function createGraphicViewExperienceRuntime(
  source: ProjectExperienceCanvasSource
): GraphicViewExperienceRuntime {
  return {
    canvas: toGraphicViewCanvas({
      participants: source.participants,
      liveTools: source.source.liveTools ?? []
    })
  };
}

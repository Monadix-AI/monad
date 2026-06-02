import type { ChatRoomCanvas, ChatRoomCanvasSource } from './utils/canvas.ts';
import type { ProjectComposerSurface } from './utils/composer.ts';

import { toChatRoomCanvas } from './utils/canvas.ts';
import { toProjectComposerSurface } from './utils/composer.ts';

export interface ChatRoomExperienceRuntime {
  canvas: ChatRoomCanvas;
  composer: ProjectComposerSurface;
}

export function createChatRoomExperienceRuntime(
  source: ChatRoomCanvasSource,
  opts: {
    openAgentCard?: (id: string) => void;
  }
): ChatRoomExperienceRuntime {
  const canvas = toChatRoomCanvas(source, {
    openAgentCard: opts.openAgentCard
  });
  return {
    canvas,
    composer: toProjectComposerSurface(canvas, canvas.typing)
  };
}

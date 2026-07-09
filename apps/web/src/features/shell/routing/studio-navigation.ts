import type { StudioSectionId } from '#/features/studio/sections';

import { runtimeSectionEnabled } from '#/features/init/init-readiness';
import { studioPath } from './paths';

export function resolveStudioNavigationPath({
  runtimeReady,
  section = 'runtime'
}: {
  runtimeReady: boolean;
  section?: StudioSectionId;
}): string {
  return studioPath(runtimeSectionEnabled(section, runtimeReady) ? section : 'runtime');
}

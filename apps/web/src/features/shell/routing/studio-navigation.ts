import { runtimeSectionEnabled } from '#/features/init/init-readiness';
import { DEFAULT_STUDIO_SECTION, type StudioSectionId } from '#/features/studio/sections';
import { studioPath } from './paths';

export function resolveStudioNavigationPath({
  runtimeReady,
  section = DEFAULT_STUDIO_SECTION
}: {
  runtimeReady: boolean;
  section?: StudioSectionId;
}): string {
  return studioPath(runtimeSectionEnabled(section, runtimeReady) ? section : 'runtime');
}

'use client';

import type { StudioSectionId } from './sections';

import { useInitStatusQuery } from '@monad/client-rtk';
import { useEffect } from 'react';

import { isRuntimeReady, runtimeSectionEnabled } from '#/features/init/init-readiness';
import { studioPath, studioSectionFromPathname, studioSubpathFromPathname } from '#/features/shell/routing/paths';
import { replaceShellUrl, useShellPathname } from '#/hooks/use-shell-location';
import { STUDIO_SECTION_COMPONENTS } from './section-registry';

/**
 * Studio: the two-plane workbench. Agent Runtime contains Monad-owned runtime policy and
 * capabilities; Agent Mesh coordinates provider-owned agents and Workplace projects.
 */
export function Studio({ onClose }: { onClose: () => void }) {
  const pathname = useShellPathname();
  const initStatus = useInitStatusQuery();
  const section: StudioSectionId = studioSectionFromPathname(pathname) ?? 'runtime';
  const runtimeReady = initStatus.isLoading ? true : isRuntimeReady(initStatus.data);
  const subpath = studioSubpathFromPathname(pathname);
  const effectiveSection = runtimeSectionEnabled(section, runtimeReady) ? section : 'runtime';
  const SectionComponent = STUDIO_SECTION_COMPONENTS[effectiveSection];

  useEffect(() => {
    if (initStatus.isLoading || runtimeSectionEnabled(section, runtimeReady)) return;
    replaceShellUrl(studioPath('runtime'));
  }, [initStatus.isLoading, runtimeReady, section]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <SectionComponent
        onClose={onClose}
        subpath={subpath}
      />
    </div>
  );
}

'use client';

import type { StudioSectionId } from './sections';

import { studioSectionFromPathname, studioSubpathFromPathname } from '@/features/routes/route-paths';
import { useShellPathname } from '@/hooks/use-shell-location';
import { STUDIO_SECTION_COMPONENTS } from './section-registry';

/**
 * Studio: the two-plane workbench. Agent Runtime contains Monad-owned runtime policy and
 * capabilities; Agent Mesh coordinates provider-owned agents and Workplace projects.
 */
export function Studio({ onClose }: { onClose: () => void }) {
  const pathname = useShellPathname();
  const section: StudioSectionId = studioSectionFromPathname(pathname) ?? 'runtime';
  const subpath = studioSubpathFromPathname(pathname);
  const SectionComponent = STUDIO_SECTION_COMPONENTS[section];

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <SectionComponent
        onClose={onClose}
        subpath={subpath}
      />
    </div>
  );
}

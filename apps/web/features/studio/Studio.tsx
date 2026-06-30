'use client';

import type { StudioSectionId } from './sections';

import { usePathname } from 'next/navigation';

import { studioSectionFromPathname } from '@/features/routes/route-paths';
import { STUDIO_SECTION_COMPONENTS } from './section-registry';

/**
 * Studio: the two-layer model/agent workbench. Capabilities (system-level atomic config, reusing
 * the existing settings panels) + Agents (compose those capabilities into a named persona).
 */
export function Studio({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const section: StudioSectionId = studioSectionFromPathname(pathname) ?? 'agents';
  const SectionComponent = STUDIO_SECTION_COMPONENTS[section];

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <SectionComponent onClose={onClose} />
    </div>
  );
}

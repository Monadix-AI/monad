import { SKILL_MARKETPLACE_SOURCES } from '@monad/protocol';

import { STUDIO_SECTION_IDS } from '@/components/studio/sections';

export function generateStaticParams() {
  return [
    ...STUDIO_SECTION_IDS.map((section) => ({ section })),
    ...SKILL_MARKETPLACE_SOURCES.map((entry) => ({ section: 'skills', trail: ['marketplace', entry.source] }))
  ];
}

export default function StudioSectionPage() {
  return null;
}

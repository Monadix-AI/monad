import { SKILL_MARKETPLACE_SOURCES } from '@monad/protocol';

import { STUDIO_SECTION_IDS } from '@/features/studio/sections';

// The `trail` catch-all is optional (`[[...trail]]`), so its root case (a bare `/studio/<section>`)
// must be enumerated with an explicit empty array — omitting `trail` leaves the optional segment
// without static params and Next's `output: export` rejects the route as "missing
// generateStaticParams" (vercel/next.js#71862).
export function generateStaticParams() {
  return [
    ...STUDIO_SECTION_IDS.map((section) => ({ section, trail: [] as string[] })),
    ...SKILL_MARKETPLACE_SOURCES.map((entry) => ({ section: 'skills', trail: ['marketplace', entry.source] }))
  ];
}

export default function StudioSectionPage() {
  return null;
}

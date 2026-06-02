import { STUDIO_SECTION_IDS } from '@/components/studio/sections';

export function generateStaticParams() {
  return STUDIO_SECTION_IDS.map((section) => ({ section }));
}

export default function StudioSectionPage() {
  return null;
}

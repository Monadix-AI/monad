import { SKILL_MARKETPLACE_SOURCES } from '@monad/protocol';

export function generateStaticParams() {
  return SKILL_MARKETPLACE_SOURCES.map((market) => ({ market: market.source }));
}

export default function SkillMarketplacePage() {
  return null;
}

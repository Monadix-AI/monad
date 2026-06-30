import {
  DEFAULT_SKILL_MARKETPLACE_SOURCE,
  SKILL_MARKETPLACE_SOURCES,
  type SkillMarketplaceSource
} from '@monad/protocol';

import { safeDecode } from '@/lib/workspace-sessions';
import { isStudioSectionId, type StudioSectionId } from '../studio/sections';

export function isStudioPath(pathname: string): boolean {
  return pathname === '/studio' || pathname.startsWith('/studio/') || isSkillMarketplacePath(pathname);
}

export function studioPath(section: StudioSectionId = 'agents'): string {
  return `/studio/${encodeURIComponent(section)}`;
}

export function studioSectionFromPathname(pathname: string): StudioSectionId | null {
  if (isSkillMarketplacePath(pathname)) return 'skills';
  if (pathname === '/studio') return 'agents';
  const raw = pathname.match(/^\/studio\/([^/?#]+)/)?.[1];
  if (!raw) return null;
  const section = safeDecode(raw);
  return isStudioSectionId(section) ? section : null;
}

export function isSkillMarketplacePath(pathname: string): boolean {
  return pathname === '/skills/marketplace' || pathname.startsWith('/skills/marketplace/');
}

export function skillMarketplaceSourceFromPathname(pathname: string): SkillMarketplaceSource | null {
  if (!isSkillMarketplacePath(pathname)) return null;
  const raw = pathname.match(/^\/skills\/marketplace\/([^/?#]+)/)?.[1];
  if (!raw) return DEFAULT_SKILL_MARKETPLACE_SOURCE;
  const source = safeDecode(raw);
  return SKILL_MARKETPLACE_SOURCES.find((entry) => entry.source === source)?.source ?? DEFAULT_SKILL_MARKETPLACE_SOURCE;
}

export function skillMarketplacePath(source: SkillMarketplaceSource = DEFAULT_SKILL_MARKETPLACE_SOURCE): string {
  return `/skills/marketplace/${encodeURIComponent(source)}`;
}

export function isWorkspacePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/workplace' ||
    pathname.startsWith('/workplace/') ||
    pathname.startsWith('/channels') ||
    pathname.startsWith('/sessions')
  );
}

export function sessionIdFromPathname(pathname: string): string | null {
  return pathname.match(/^\/sessions\/([^/?#]+)/)?.[1] ?? null;
}

export function projectIdFromPathname(pathname: string): string | null {
  const raw = pathname.match(/^\/workplace\/projects\/([^/?#]+)/)?.[1] ?? pathname.match(/^\/channels\/([^/?#]+)/)?.[1];
  if (!raw) return null;
  return safeDecode(raw);
}

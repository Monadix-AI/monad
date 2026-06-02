import { safeDecode } from '@/lib/workspace-sessions';
import { isStudioSectionId, type StudioSectionId } from '../studio/sections';

export function isStudioPath(pathname: string): boolean {
  return pathname === '/studio' || pathname.startsWith('/studio/');
}

export function studioPath(section: StudioSectionId = 'agents'): string {
  return `/studio/${encodeURIComponent(section)}`;
}

export function studioSectionFromPathname(pathname: string): StudioSectionId | null {
  if (pathname === '/studio') return 'agents';
  const raw = pathname.match(/^\/studio\/([^/?#]+)/)?.[1];
  if (!raw) return null;
  const section = safeDecode(raw);
  return isStudioSectionId(section) ? section : null;
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

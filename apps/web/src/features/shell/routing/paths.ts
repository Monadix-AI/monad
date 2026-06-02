import {
  DEFAULT_SKILL_MARKETPLACE_SOURCE,
  type InboxFilter,
  inboxFilterSchema,
  SKILL_MARKETPLACE_SOURCES,
  type SkillMarketplaceSource
} from '@monad/protocol';

import { normalizeSettingsSection, type SettingsSectionId } from '#/features/settings/sections';
import { DEFAULT_STUDIO_SECTION, isStudioSectionId, type StudioSectionId } from '#/features/studio/sections';
import { safeDecode } from '#/lib/workspace-sessions';

const NANOID_PATTERN = '[0-9A-Za-z_-]{12}';
const PROJECT_ROUTE_ID_PATTERN = `prj_${NANOID_PATTERN}`;
const SESSION_ROUTE_ID_PATTERN = `ses_${NANOID_PATTERN}`;

export function isStudioPath(pathname: string): boolean {
  return pathname.startsWith('/studio/');
}

export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

export const INBOX_FILTERS = ['needs-response', 'unread', 'completed', 'all'] as const satisfies readonly InboxFilter[];
export const DEFAULT_INBOX_FILTER = 'needs-response' as const satisfies InboxFilter;

export function inboxPath(filter: InboxFilter = DEFAULT_INBOX_FILTER): string {
  return `/inbox/${filter}`;
}

export function isInboxPath(pathname: string): boolean {
  return pathname === '/inbox' || pathname.startsWith('/inbox/');
}

export function inboxFilterFromPathname(pathname: string): InboxFilter | null {
  const raw = pathname.match(/^\/inbox\/([^/?#]+)(?:[/?#]|$)/)?.[1];
  if (!raw) return null;
  const parsed = inboxFilterSchema.safeParse(safeDecode(raw));
  return parsed.success ? parsed.data : null;
}

export function settingsPath(section: SettingsSectionId = 'connection'): string {
  return `/settings/${encodeURIComponent(section)}`;
}

export function settingsSectionFromPathname(pathname: string): SettingsSectionId | null {
  const raw = pathname.match(/^\/settings(?:\/([^/?#]+))?/)?.[1];
  if (!raw) return 'connection';
  const section = safeDecode(raw);
  return normalizeSettingsSection(section);
}

export function studioPath(section: StudioSectionId = DEFAULT_STUDIO_SECTION): string {
  return `/studio/${encodeURIComponent(section)}`;
}

export function studioDetailPath(section: StudioSectionId, ...trail: string[]): string {
  const encodedTrail = trail.filter(Boolean).map((part) => encodeURIComponent(part));
  return [studioPath(section), ...encodedTrail].join('/');
}

export function agentDetailsPath(agentId: string): string {
  return studioDetailPath('agents', agentId);
}

export function agentEditPath(agentId: string): string {
  return studioDetailPath('agents', agentId, 'edit');
}

export function studioSectionFromPathname(pathname: string): StudioSectionId | null {
  const raw = pathname.match(/^\/studio\/([^/?#]+)/)?.[1];
  if (!raw) return null;
  const section = safeDecode(raw);
  if (section === 'acpAgents') return 'acpDelegates';
  if (section === 'thirdPartyAgents') {
    const mode = studioSubpathFromPathname(pathname)[0];
    if (mode === 'cli') return 'meshAgents';
    return 'acpDelegates';
  }
  return isStudioSectionId(section) ? section : null;
}

export function studioSubpathFromPathname(pathname: string): string[] {
  const raw = pathname.match(/^\/studio\/[^/?#]+\/([^?#]*)/)?.[1];
  if (!raw) return [];
  return raw
    .split('/')
    .filter(Boolean)
    .map((part) => safeDecode(part));
}

export function isSkillMarketplacePath(pathname: string): boolean {
  return pathname === '/studio/skills/marketplace' || pathname.startsWith('/studio/skills/marketplace/');
}

export function skillMarketplaceSourceFromPathname(pathname: string): SkillMarketplaceSource | null {
  if (!isSkillMarketplacePath(pathname)) return null;
  const raw = pathname.match(/^\/studio\/skills\/marketplace\/([^/?#]+)/)?.[1];
  if (!raw) return DEFAULT_SKILL_MARKETPLACE_SOURCE;
  const source = safeDecode(raw);
  return SKILL_MARKETPLACE_SOURCES.find((entry) => entry.source === source)?.source ?? DEFAULT_SKILL_MARKETPLACE_SOURCE;
}

export function skillMarketplacePath(source: SkillMarketplaceSource = DEFAULT_SKILL_MARKETPLACE_SOURCE): string {
  return `/studio/skills/marketplace/${encodeURIComponent(source)}`;
}

export function isWorkspacePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    isInboxPath(pathname) ||
    new RegExp(`^/workspace/${PROJECT_ROUTE_ID_PATTERN}(?:[/?#]|$)`).test(pathname) ||
    new RegExp(`^/workspace/${PROJECT_ROUTE_ID_PATTERN}/settings(?:[/?#]|$)`).test(pathname) ||
    new RegExp(`^/workspace/${PROJECT_ROUTE_ID_PATTERN}/${SESSION_ROUTE_ID_PATTERN}(?:[/?#]|$)`).test(pathname) ||
    pathname.startsWith('/sessions/')
  );
}

export function sessionIdFromPathname(pathname: string): string | null {
  return pathname.match(/^\/sessions\/([^/?#]+)/)?.[1] ?? null;
}

export function projectRouteId(projectId: string): string {
  return projectId;
}

export function sessionRouteId(sessionId: string): string {
  return sessionId;
}

export function sessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionRouteId(sessionId))}`;
}

export function projectPath(projectId: string): string {
  return `/workspace/${encodeURIComponent(projectRouteId(projectId))}`;
}

export function projectSettingsPath(projectId: string): string {
  return `${projectPath(projectId)}/settings`;
}

export function projectSessionPath(projectId: string, sessionId: string): string {
  return `${projectPath(projectId)}/${encodeURIComponent(sessionRouteId(sessionId))}`;
}

export function projectIdFromPathname(pathname: string): string | null {
  const raw = pathname.match(
    new RegExp(`^/workspace/(${PROJECT_ROUTE_ID_PATTERN})(?:/(?:settings|${SESSION_ROUTE_ID_PATTERN}))?(?:[/?#]|$)`)
  )?.[1];
  if (!raw) return null;
  return safeDecode(raw);
}

export function isProjectSettingsPath(pathname: string): boolean {
  return new RegExp(`^/workspace/${PROJECT_ROUTE_ID_PATTERN}/settings(?:[/?#]|$)`).test(pathname);
}

export function projectSessionIdFromPathname(pathname: string): string | null {
  const raw = pathname.match(
    new RegExp(`^/workspace/${PROJECT_ROUTE_ID_PATTERN}/(${SESSION_ROUTE_ID_PATTERN})(?:[/?#]|$)`)
  )?.[1];
  if (!raw) return null;
  return safeDecode(raw);
}

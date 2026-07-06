import { describe, expect, test } from 'bun:test';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE } from '@monad/protocol';

import {
  isSkillMarketplacePath,
  isStudioPath,
  isWorkspacePath,
  projectIdFromPathname,
  sessionIdFromPathname,
  skillMarketplacePath,
  skillMarketplaceSourceFromPathname,
  studioDetailPath,
  studioPath,
  studioSectionFromPathname,
  studioSubpathFromPathname
} from '../../features/routes/route-paths.ts';

describe('canonical web route helpers', () => {
  test('keeps Studio sections and their internal breadcrumbs under /studio', () => {
    expect(studioPath()).toBe('/studio/runtime');
    expect(studioPath('skills')).toBe('/studio/skills');
    expect(studioPath('acpDelegates')).toBe('/studio/acpDelegates');
    expect(studioPath('nativeCliAgents')).toBe('/studio/nativeCliAgents');
    expect(skillMarketplacePath(DEFAULT_SKILL_MARKETPLACE_SOURCE)).toBe(
      `/studio/skills/marketplace/${encodeURIComponent(DEFAULT_SKILL_MARKETPLACE_SOURCE)}`
    );
    expect(isStudioPath('/studio/skills/marketplace/clawhub')).toBe(true);
    expect(isSkillMarketplacePath('/studio/skills/marketplace/clawhub')).toBe(true);
    expect(studioSectionFromPathname('/studio/skills/marketplace/clawhub')).toBe('skills');
    expect(studioSectionFromPathname('/studio/acpAgents')).toBe('acpDelegates');
    expect(studioSectionFromPathname('/studio/nativeCliAgents')).toBe('nativeCliAgents');
    expect(skillMarketplaceSourceFromPathname('/studio/skills/marketplace/clawhub')).toBe('clawhub');
  });

  test('keeps Studio secondary pages URL-backed for breadcrumb navigation', () => {
    expect(studioDetailPath('agents', 'agent 1')).toBe('/studio/agents/agent%201');
    expect(studioDetailPath('nativeCliAgents', 'cli')).toBe('/studio/nativeCliAgents/cli');
    expect(studioSubpathFromPathname('/studio/agents/agent%201')).toEqual(['agent 1']);
    expect(studioSubpathFromPathname('/studio/nativeCliAgents/cli')).toEqual(['cli']);
  });

  test('does not classify old marketplace routes as Studio routes', () => {
    expect(isStudioPath('/skills/marketplace')).toBe(false);
    expect(isSkillMarketplacePath('/skills/marketplace/clawhub')).toBe(false);
  });

  test('keeps workspace route parsing on canonical workspace and session paths', () => {
    expect(isWorkspacePath('/')).toBe(true);
    expect(isWorkspacePath('/workplace/projects/project%201')).toBe(true);
    expect(isWorkspacePath('/sessions/session-1')).toBe(true);
    expect(projectIdFromPathname('/workplace/projects/project%201')).toBe('project 1');
    expect(sessionIdFromPathname('/sessions/session-1')).toBe('session-1');
  });

  test('does not classify old channel routes as workspace project routes', () => {
    expect(isWorkspacePath('/channels')).toBe(false);
    expect(isWorkspacePath('/channels/project-1')).toBe(false);
  });
});

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
    expect(studioPath()).toBe('/studio/agents');
    expect(studioPath('skills')).toBe('/studio/skills');
    expect(studioPath('thirdPartyAgents')).toBe('/studio/thirdPartyAgents');
    expect(skillMarketplacePath(DEFAULT_SKILL_MARKETPLACE_SOURCE)).toBe(
      `/studio/skills/marketplace/${encodeURIComponent(DEFAULT_SKILL_MARKETPLACE_SOURCE)}`
    );
    expect(isStudioPath('/studio/skills/marketplace/clawhub')).toBe(true);
    expect(isSkillMarketplacePath('/studio/skills/marketplace/clawhub')).toBe(true);
    expect(studioSectionFromPathname('/studio/skills/marketplace/clawhub')).toBe('skills');
    expect(studioSectionFromPathname('/studio/acpAgents')).toBe('thirdPartyAgents');
    expect(studioSectionFromPathname('/studio/nativeCliAgents')).toBe('thirdPartyAgents');
    expect(skillMarketplaceSourceFromPathname('/studio/skills/marketplace/clawhub')).toBe('clawhub');
  });

  test('keeps Studio secondary pages URL-backed for breadcrumb navigation', () => {
    expect(studioDetailPath('agents', 'agent 1')).toBe('/studio/agents/agent%201');
    expect(studioDetailPath('thirdPartyAgents', 'cli')).toBe('/studio/thirdPartyAgents/cli');
    expect(studioSubpathFromPathname('/studio/agents/agent%201')).toEqual(['agent 1']);
    expect(studioSubpathFromPathname('/studio/thirdPartyAgents/acp')).toEqual(['acp']);
    expect(studioSubpathFromPathname('/studio/models')).toEqual([]);
  });

  test('does not classify old marketplace routes as Studio routes', () => {
    expect(isStudioPath('/skills/marketplace')).toBe(false);
    expect(isSkillMarketplacePath('/skills/marketplace/clawhub')).toBe(false);
    expect(skillMarketplaceSourceFromPathname('/skills/marketplace/clawhub')).toBe(null);
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
    expect(projectIdFromPathname('/channels/project-1')).toBe(null);
  });
});

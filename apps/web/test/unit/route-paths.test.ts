import { describe, expect, test } from 'bun:test';
import { DEFAULT_SKILL_MARKETPLACE_SOURCE } from '@monad/protocol';

import {
  isSettingsPath,
  isSkillMarketplacePath,
  isStudioPath,
  isWorkspacePath,
  projectIdFromPathname,
  projectPath,
  projectRouteId,
  projectSessionIdFromPathname,
  projectSessionPath,
  sessionIdFromPathname,
  sessionRouteId,
  settingsPath,
  settingsSectionFromPathname,
  skillMarketplacePath,
  skillMarketplaceSourceFromPathname,
  studioDetailPath,
  studioPath,
  studioSectionFromPathname,
  studioSubpathFromPathname
} from '../../src/features/shell/routing/paths.ts';

describe('canonical web route helpers', () => {
  test('keeps Studio sections and their internal breadcrumbs under /studio', () => {
    expect(studioPath()).toBe('/studio/runtime');
    expect(studioPath('skills')).toBe('/studio/skills');
    expect(studioPath('acpDelegates')).toBe('/studio/acpDelegates');
    expect(studioPath('externalAgents')).toBe('/studio/externalAgents');
    expect(studioPath('import')).toBe('/studio/import');
    expect(skillMarketplacePath(DEFAULT_SKILL_MARKETPLACE_SOURCE)).toBe(
      `/studio/skills/marketplace/${encodeURIComponent(DEFAULT_SKILL_MARKETPLACE_SOURCE)}`
    );
    expect(isStudioPath('/studio/skills/marketplace/clawhub')).toBe(true);
    expect(isSkillMarketplacePath('/studio/skills/marketplace/clawhub')).toBe(true);
    expect(studioSectionFromPathname('/studio/skills/marketplace/clawhub')).toBe('skills');
    expect(studioSectionFromPathname('/studio/acpAgents')).toBe('acpDelegates');
    expect(studioSectionFromPathname('/studio/externalAgents')).toBe('externalAgents');
    expect(studioSectionFromPathname('/studio/import')).toBe('import');
    expect(skillMarketplaceSourceFromPathname('/studio/skills/marketplace/clawhub')).toBe('clawhub');
  });

  test('keeps Studio secondary pages URL-backed for breadcrumb navigation', () => {
    expect(studioDetailPath('agents', 'agent 1')).toBe('/studio/agents/agent%201');
    expect(studioDetailPath('externalAgents', 'cli')).toBe('/studio/externalAgents/cli');
    expect(studioDetailPath('import', 'claude-code')).toBe('/studio/import/claude-code');
    expect(studioSubpathFromPathname('/studio/agents/agent%201')).toEqual(['agent 1']);
    expect(studioSubpathFromPathname('/studio/externalAgents/cli')).toEqual(['cli']);
    expect(studioSubpathFromPathname('/studio/import/claude-code')).toEqual(['claude-code']);
  });

  test('does not classify old marketplace routes as Studio routes', () => {
    expect(isStudioPath('/skills/marketplace')).toBe(false);
    expect(isSkillMarketplacePath('/skills/marketplace/clawhub')).toBe(false);
  });

  test('keeps workspace route parsing on canonical workspace and session paths', () => {
    expect(isWorkspacePath('/')).toBe(true);
    expect(isWorkspacePath('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012')).toBe(true);
    expect(isWorkspacePath('/sessions/session-1')).toBe(true);
    expect(isWorkspacePath('/workspace/ABCDEF123456/UVWXYZ789012')).toBe(false);
    expect(isWorkspacePath('/workspace/prj_short/ses_UVWXYZ789012')).toBe(false);
    expect(projectIdFromPathname('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012')).toBe('prj_ABCDEF123456');
    expect(projectSessionIdFromPathname('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012')).toBe('ses_UVWXYZ789012');
    expect(projectSessionIdFromPathname('/workspace/prj_ABCDEF123456')).toBeNull();
    expect(isWorkspacePath('/workspace/prj_ABCDEF12345!/ses_UVWXYZ789012')).toBe(false);
    expect(projectRouteId('prj_ABCDEF123456')).toBe('prj_ABCDEF123456');
    expect(sessionRouteId('ses_UVWXYZ789012')).toBe('ses_UVWXYZ789012');
    expect(projectPath('prj_ABCDEF123456')).toBe('/workspace/prj_ABCDEF123456');
    expect(projectSessionPath('prj_ABCDEF123456', 'ses_UVWXYZ789012')).toBe(
      '/workspace/prj_ABCDEF123456/ses_UVWXYZ789012'
    );
    expect(sessionIdFromPathname('/sessions/session-1')).toBe('session-1');
  });

  test('keeps settings as a top-level route instead of a modal query', () => {
    expect(settingsPath('system')).toBe('/settings/system');
    expect(settingsPath('experience')).toBe('/settings/experience');
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/system')).toBe(true);
    expect(settingsSectionFromPathname('/settings/system')).toBe('system');
    expect(settingsSectionFromPathname('/settings/language')).toBe('experience');
    expect(isSettingsPath('/studio/runtime?panel=system')).toBe(false);
  });

  test('does not classify old channel routes as workspace project routes', () => {
    expect(isWorkspacePath('/channels')).toBe(false);
    expect(isWorkspacePath('/channels/project-1')).toBe(false);
  });
});

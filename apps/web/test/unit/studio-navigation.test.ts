import { describe, expect, test } from 'bun:test';

import { agentDetailsPath, agentEditPath, sessionPath } from '../../src/features/shell/routing/paths.ts';
import { resolveStudioNavigationPath } from '../../src/features/shell/routing/studio-navigation.ts';
import { resolveSidebarPagerTarget } from '../../src/features/shell/sidebar-trackpad-switch.ts';
import {
  DEFAULT_STUDIO_SECTION,
  STUDIO_RUNTIME_SECTIONS,
  STUDIO_SIDEBAR_SECTIONS,
  STUDIO_SYSTEM_SECTIONS
} from '../../src/features/studio/sections.ts';

describe('Studio shell navigation', () => {
  test('builds stable Agent detail, edit, and chat session destinations', () => {
    expect(agentDetailsPath('agt_000000000001')).toBe('/studio/agents/agt_000000000001');
    expect(agentEditPath('agt_000000000001')).toBe('/studio/agents/agt_000000000001/edit');
    expect(sessionPath('ses_000000000001')).toBe('/sessions/ses_000000000001');
  });

  test('keeps Credentials in Agent Runtime between Agents and Capabilities', () => {
    const runtimeIds = STUDIO_RUNTIME_SECTIONS.map((section) => section.id);
    expect(runtimeIds.slice(runtimeIds.indexOf('agents'), runtimeIds.indexOf('capabilities') + 1)).toEqual([
      'agents',
      'credentials',
      'capabilities'
    ]);
    expect(STUDIO_SYSTEM_SECTIONS.map((section) => section.id)).not.toContain('credentials');
  });

  test('exposes installed messaging configuration in the System section', () => {
    expect(STUDIO_SYSTEM_SECTIONS.map(({ id, i18nKey }) => ({ id, i18nKey }))).toEqual([
      { id: 'channels', i18nKey: 'web.ch.title' },
      { id: 'import', i18nKey: 'web.settings.import' },
      { id: 'atoms', i18nKey: 'web.studio.atoms' }
    ]);
  });
  test('uses the first sidebar item as the default Studio route', () => {
    expect(STUDIO_SIDEBAR_SECTIONS[0]?.id).toBe(DEFAULT_STUDIO_SECTION);
    expect(resolveStudioNavigationPath({ runtimeReady: true })).toBe('/studio/mesh');
  });

  test('falls back to runtime when the requested section is disabled', () => {
    expect(resolveStudioNavigationPath({ runtimeReady: false, section: 'agents' })).toBe('/studio/runtime');
  });

  test('exposes Safety and Hooks as separate runtime settings destinations', () => {
    expect(
      STUDIO_RUNTIME_SECTIONS.filter(({ id }) => id === 'safety' || id === 'hooks').map(({ id, i18nKey }) => ({
        id,
        i18nKey
      }))
    ).toEqual([
      { id: 'safety', i18nKey: 'web.studio.safety' },
      { id: 'hooks', i18nKey: 'web.studio.hooks' }
    ]);
  });
});

describe('sidebar pager target resolution', () => {
  test('commits the Studio surface as soon as the page turn targets the Studio page', () => {
    expect(resolveSidebarPagerTarget({ clientWidth: 300, dragOrigin: 0, dragPxTotal: 160, scrollLeft: 160 })).toBe(1);
  });

  test('commits the workspace surface when the page turn targets the workspace page', () => {
    expect(resolveSidebarPagerTarget({ clientWidth: 300, dragOrigin: 300, dragPxTotal: -160, scrollLeft: 140 })).toBe(
      0
    );
  });

  test('supports a hidden settings page in the same pager interaction', () => {
    expect(
      resolveSidebarPagerTarget({
        clientWidth: 300,
        dragOrigin: 300,
        dragPxTotal: -160,
        pageCount: 3,
        scrollLeft: 440
      })
    ).toBe(0);
    expect(
      resolveSidebarPagerTarget({
        clientWidth: 300,
        dragOrigin: 300,
        dragPxTotal: 160,
        pageCount: 3,
        scrollLeft: 460
      })
    ).toBe(2);
  });
});

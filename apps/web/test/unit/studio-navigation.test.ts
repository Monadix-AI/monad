import { describe, expect, test } from 'bun:test';

import { resolveStudioNavigationPath } from '../../features/shell/app-shell/studio-navigation.ts';
import { resolveSidebarPagerTarget } from '../../features/shell/sidebar-trackpad-switch.ts';

describe('Studio shell navigation', () => {
  test('defaults sidebar Studio switches to the runtime router', () => {
    expect(resolveStudioNavigationPath({ runtimeReady: true })).toBe('/studio/runtime');
  });

  test('falls back to runtime when the requested section is disabled', () => {
    expect(resolveStudioNavigationPath({ runtimeReady: false, section: 'agents' })).toBe('/studio/runtime');
  });
});

describe('sidebar pager target resolution', () => {
  test('commits the Studio surface as soon as the page turn targets the Studio page', () => {
    expect(resolveSidebarPagerTarget({ clientWidth: 300, dragOrigin: 0, dragPxTotal: 160, scrollLeft: 160 })).toBe(
      'studio'
    );
  });

  test('commits the workspace surface when the page turn targets the workspace page', () => {
    expect(resolveSidebarPagerTarget({ clientWidth: 300, dragOrigin: 300, dragPxTotal: -160, scrollLeft: 140 })).toBe(
      'workspace'
    );
  });
});

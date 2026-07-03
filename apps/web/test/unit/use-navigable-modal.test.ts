import { describe, expect, test } from 'bun:test';

import { buildNavigableModalUrl } from '../../hooks/use-navigable-modal.ts';

describe('buildNavigableModalUrl', () => {
  test('opens modal state on the current canonical route', () => {
    expect(buildNavigableModalUrl('/studio/skills/marketplace/clawhub', '', 'settings', 'import')).toBe(
      '/studio/skills/marketplace/clawhub?settings=import'
    );
  });

  test('replaces modal state while preserving other params', () => {
    expect(buildNavigableModalUrl('/sessions/s1', 'msg=m1&settings=connection', 'settings', 'language')).toBe(
      '/sessions/s1?msg=m1&settings=language'
    );
  });

  test('closes modal state without changing the route', () => {
    expect(buildNavigableModalUrl('/workplace/projects/p1', 'settings=connection', 'settings', null)).toBe(
      '/workplace/projects/p1'
    );
  });
});

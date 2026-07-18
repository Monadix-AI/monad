import { describe, expect, test } from 'bun:test';

import {
  getSidebarSessionTitleMotion,
  SIDEBAR_SESSION_TITLE_DELAY_MS
} from '../../src/features/shell/sidebar/sidebar-session-title-motion.ts';

describe('sidebar session title motion', () => {
  test('keeps a fitting title stationary', () => {
    expect(getSidebarSessionTitleMotion({ actionWidth: 22, titleWidth: 120, viewportWidth: 200 })).toEqual({
      distancePx: 0,
      durationMs: 0,
      overflowing: false
    });
  });

  test('includes the action overlay and fade in the terminal distance', () => {
    expect(getSidebarSessionTitleMotion({ actionWidth: 44, titleWidth: 260, viewportWidth: 200 })).toEqual({
      distancePx: 124,
      durationMs: 3100,
      overflowing: true
    });
  });

  test('clamps invalid or subpixel reverse distances to zero', () => {
    expect(getSidebarSessionTitleMotion({ actionWidth: -10, titleWidth: 180, viewportWidth: 200 }).distancePx).toBe(0);
    expect(SIDEBAR_SESSION_TITLE_DELAY_MS).toBe(600);
  });
});

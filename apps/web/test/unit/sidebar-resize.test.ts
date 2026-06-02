import { describe, expect, test } from 'bun:test';

import { sidebarResizeState } from '../../src/features/shell/use-sidebar-resize.ts';

describe('sidebar resize state', () => {
  test.each([
    [191, true, 240],
    [192, true, 240],
    [193, false, 240],
    [240, false, 240],
    [500, false, 420]
  ])('maps raw width %i to collapsed=%s and width=%i', (rawWidth, collapsed, width) => {
    expect(sidebarResizeState(rawWidth)).toEqual({ collapsed, width });
  });
});

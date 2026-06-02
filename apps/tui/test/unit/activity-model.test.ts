import { expect, test } from 'bun:test';

import { activityFrame } from '../../src/shell/activity-model.ts';

test('activity frames animate without changing terminal width', () => {
  const frames = Array.from({ length: 12 }, (_, tick) => activityFrame(tick));

  expect(new Set(frames).size).toBeGreaterThan(1);
  expect(frames.every((frame) => Array.from(frame).length === 1)).toBe(true);
});

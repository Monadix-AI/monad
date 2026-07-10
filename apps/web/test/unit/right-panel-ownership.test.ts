import { expect, test } from 'bun:test';

import {
  activateRightPanelOwner,
  canRenderRightPanelContent,
  createRightPanelOwnership,
  registerRightPanelContent,
  unregisterRightPanelContent
} from '../../src/features/shell/right-panel/right-panel-ownership.ts';

test('right panel rejects content from the previous route owner synchronously', () => {
  const oldOwner = 'session:ses_old';
  const nextOwner = 'session:ses_next';
  const registered = registerRightPanelContent(createRightPanelOwnership(oldOwner), oldOwner, 'old-content');
  const switched = activateRightPanelOwner(registered, nextOwner);

  expect(canRenderRightPanelContent(switched, oldOwner, 'old-content')).toBe(false);
  expect(switched.registration).toBeNull();
});

test('right panel accepts only the active route owner', () => {
  const owner = 'session:ses_current';
  const initial = createRightPanelOwnership(owner);

  expect(registerRightPanelContent(initial, 'session:ses_other', 'other-content')).toEqual(initial);

  const registered = registerRightPanelContent(initial, owner, 'current-content');
  expect(canRenderRightPanelContent(registered, owner, 'current-content')).toBe(true);
  expect(canRenderRightPanelContent(registered, owner, 'stale-content')).toBe(false);
});

test('stale cleanup cannot unregister newer content', () => {
  const owner = 'session:ses_current';
  const first = registerRightPanelContent(createRightPanelOwnership(owner), owner, 'first-content');
  const second = registerRightPanelContent(first, owner, 'second-content');

  expect(unregisterRightPanelContent(second, 'first-content')).toEqual(second);
  expect(unregisterRightPanelContent(second, 'second-content').registration).toBeNull();
});

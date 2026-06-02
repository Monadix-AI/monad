import { expect, test } from 'bun:test';

import { resolveSessionSidebarStatus } from '../../src/features/shell/sidebar/session-attention-marker';
import { resolveSidebarEndcapSlot, sidebarActionsVisible } from '../../src/features/shell/sidebar/workspace-tree-item';

test('keyboard focus and an open menu control persistent sidebar actions', () => {
  expect(
    sidebarActionsVisible({
      focusVisibleWithin: false,
      menuOpen: false
    })
  ).toBe(false);
  expect(
    sidebarActionsVisible({
      focusVisibleWithin: true,
      menuOpen: false
    })
  ).toBe(true);
  expect(
    sidebarActionsVisible({
      focusVisibleWithin: false,
      menuOpen: true
    })
  ).toBe(true);
});

test('hotkey wins the endcap before actions and attention status', () => {
  expect(resolveSidebarEndcapSlot({ actionsVisible: true, hasStatus: true, shortcutVisible: true })).toBe('shortcut');
  expect(resolveSidebarEndcapSlot({ actionsVisible: true, hasStatus: true, shortcutVisible: false })).toBe('actions');
  expect(resolveSidebarEndcapSlot({ actionsVisible: false, hasStatus: true, shortcutVisible: false })).toBe('status');
});

test('session status prioritizes pending interaction, failure, running, then unread', () => {
  expect([
    resolveSessionSidebarStatus({ attentionState: 'need-approval', generationState: 'error' }),
    resolveSessionSidebarStatus({ attentionState: 'need-response', generationState: 'running' }),
    resolveSessionSidebarStatus({ attentionState: 'unread', generationState: 'error' }),
    resolveSessionSidebarStatus({ attentionState: 'unread', generationState: 'running' }),
    resolveSessionSidebarStatus({ attentionState: 'unread', generationState: null })
  ]).toEqual(['need-approval', 'need-response', 'error', 'running', 'unread']);
});

import { describe, expect, test } from 'bun:test';

import { capabilityIds, NAV_CAPABILITIES } from '../../src/shell/capabilities.ts';
import { globalShortcut } from '../../src/shell/keymap.ts';
import {
  chatPaneWidths,
  layoutMode,
  navigationIndexAtRow,
  shouldShowProjection,
  transcriptOffsetAfterWheel
} from '../../src/shell/layout-model.ts';

describe('layoutMode', () => {
  test('selects the agreed responsive modes', () => {
    expect(layoutMode(140, 40)).toBe('wide');
    expect(layoutMode(100, 30)).toBe('medium');
    expect(layoutMode(70, 20)).toBe('compact');
    expect(layoutMode(59, 20)).toBe('too-small');
    expect(layoutMode(80, 17)).toBe('too-small');
  });
});

describe('wide chat panes', () => {
  test('shows projection only for an associated mesh-agent session', () => {
    expect(shouldShowProjection('wide', true, true, 0)).toBe(false);
    expect(shouldShowProjection('wide', true, true, 1)).toBe(true);
    expect(shouldShowProjection('medium', true, true, 1)).toBe(false);
    expect(shouldShowProjection('wide', false, true, 1)).toBe(false);
  });

  test('allocates deterministic integer widths from terminal geometry', () => {
    const projected = chatPaneWidths(160, 30, true);
    const transcriptOnly = chatPaneWidths(160, 30, false);

    expect(projected).toEqual(chatPaneWidths(160, 30, true));
    expect(projected.transcript + projected.projection).toBe(128);
    expect(projected.transcript).toBeGreaterThan(projected.projection);
    expect(Number.isInteger(projected.transcript)).toBe(true);
    expect(transcriptOnly).toEqual({ projection: 0, transcript: 128 });
  });
});

describe('mouse layout routing', () => {
  test('maps the first navigation text row to the first capability', () => {
    expect(navigationIndexAtRow(3)).toBeNull();
    expect(navigationIndexAtRow(4)).toBe(0);
    expect(navigationIndexAtRow(5)).toBe(1);
  });

  test('pages the transcript wheel toward older or live messages', () => {
    expect(transcriptOffsetAfterWheel(0, 'wheel-up')).toBe(20);
    expect(transcriptOffsetAfterWheel(40, 'wheel-down')).toBe(20);
    expect(transcriptOffsetAfterWheel(0, 'wheel-down')).toBe(0);
  });
});

describe('globalShortcut', () => {
  const key = (overrides: Record<string, boolean> = {}) => ({
    ctrl: false,
    escape: false,
    shift: false,
    tab: false,
    ...overrides
  });

  test('maps the globally discoverable shortcuts', () => {
    expect(globalShortcut('k', key({ ctrl: true }), false)).toBe('palette.toggle');
    expect(globalShortcut(',', key({ ctrl: true }), false)).toBe('surface.settings');
    expect(globalShortcut('`', key({ ctrl: true }), false)).toBe('surface.workspace');
    expect(globalShortcut('?', key(), false)).toBe('help.toggle');
  });

  test('does not treat printable help input as global while composing', () => {
    expect(globalShortcut('?', key(), true)).toBeNull();
  });
});

describe('navigation capability registry', () => {
  test('contains every agreed top-level product concept once', () => {
    const ids = capabilityIds(NAV_CAPABILITIES);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'workspace.inbox',
        'workspace.projects',
        'workspace.chats',
        'studio.runtime',
        'studio.models',
        'studio.meshAgents',
        'studio.memory',
        'settings.connection',
        'settings.preferences',
        'settings.mo'
      ])
    );
  });

  test('marks every item with an explicit degradation mode', () => {
    expect(NAV_CAPABILITIES.every((item) => ['native', 'summary', 'web-only'].includes(item.mode))).toBe(true);
  });
});

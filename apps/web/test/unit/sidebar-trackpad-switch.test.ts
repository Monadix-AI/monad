import { describe, expect, test } from 'bun:test';

import {
  createSidebarPagerGesture,
  isSidebarHorizontalWheel,
  sidebarTrackpadEdgeAccum,
  sidebarTrackpadEdgeOffset
} from '../../features/shell/sidebar-trackpad-switch.ts';

describe('sidebar pager gesture', () => {
  test('recognizes horizontal wheel gestures for the reveal strip', () => {
    expect(isSidebarHorizontalWheel({ deltaX: -18, deltaY: 4 })).toBe(true);
    expect(isSidebarHorizontalWheel({ deltaX: 18, deltaY: 4 })).toBe(true);
    expect(isSidebarHorizontalWheel({ deltaX: 18, deltaY: 20 })).toBe(true);
    expect(isSidebarHorizontalWheel({ deltaX: 2, deltaY: 24 })).toBe(false);
    expect(isSidebarHorizontalWheel({ deltaX: 1, deltaY: 0 })).toBe(false);
  });

  test('drag accumulates the stream 1:1', () => {
    const pager = createSidebarPagerGesture();

    expect(pager.update({ deltaX: 30, now: 0 })).toEqual({ dragPx: 30, kind: 'drag' });
    expect(pager.update({ deltaX: 30, now: 16 })).toEqual({ dragPx: 60, kind: 'drag' });
    expect(pager.update({ deltaX: -10, now: 32 })).toEqual({ dragPx: 50, kind: 'drag' });
  });

  test('a stream gap starts a fresh drag', () => {
    const pager = createSidebarPagerGesture();

    pager.update({ deltaX: 80, now: 0 });
    expect(pager.update({ deltaX: 20, now: 400 })).toEqual({ dragPx: 20, kind: 'drag' });
  });

  test('a decaying momentum tail settles the page turn and swallows the rest', () => {
    const pager = createSidebarPagerGesture();

    pager.update({ deltaX: 80, now: 0 });
    pager.update({ deltaX: 36, now: 16 });
    pager.update({ deltaX: 30, now: 32 });
    pager.update({ deltaX: 25, now: 48 });
    const settled = pager.update({ deltaX: 20, now: 64 });
    expect(settled.kind).toBe('settle');
    expect(settled.dragPx).toBe(171);

    expect(pager.update({ deltaX: 16, now: 80 }).kind).toBe('swallowed');
    expect(pager.update({ deltaX: 12, now: 96 }).kind).toBe('swallowed');
  });

  test('a fresh push re-engages immediately from the swallow state', () => {
    const pager = createSidebarPagerGesture();

    pager.swallowTail(0, 20);
    expect(pager.update({ deltaX: 16, now: 16 }).kind).toBe('swallowed');
    const fresh = pager.update({ deltaX: 30, now: 32 });
    expect(fresh.kind).toBe('drag');
    expect(fresh.dragPx).toBe(30);
  });

  test('seedPx only applies when a new drag starts', () => {
    const pager = createSidebarPagerGesture();

    expect(pager.update({ deltaX: 10, now: 0, seedPx: -100 })).toEqual({ dragPx: -90, kind: 'drag' });
    expect(pager.update({ deltaX: 10, now: 16, seedPx: -500 })).toEqual({ dragPx: -80, kind: 'drag' });
  });

  test('a steady push never settles', () => {
    const pager = createSidebarPagerGesture();

    for (let i = 0; i < 12; i += 1) {
      expect(pager.update({ deltaX: -30, now: i * 16 }).kind).toBe('drag');
    }
  });

  test('edge rubber band is asymptotic to the provided panel width', () => {
    expect(sidebarTrackpadEdgeOffset(-780, 432)).toBeGreaterThan(380);
    expect(sidebarTrackpadEdgeOffset(-780, 432)).toBeLessThan(432);
    expect(sidebarTrackpadEdgeOffset(780, 252)).toBeLessThan(-220);
    expect(sidebarTrackpadEdgeOffset(0, 252)).toBe(0);
  });

  test('edge accum inverts the rubber band for jump-free re-engagement', () => {
    const offset = sidebarTrackpadEdgeOffset(-200, 300);
    const accum = sidebarTrackpadEdgeAccum(offset, 300);
    expect(Math.abs(accum - -200)).toBeLessThan(1);
    expect(sidebarTrackpadEdgeAccum(0, 300)).toBe(0);
  });
});

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('sidebar paging is fully pager-driven with a JS edge rubber band', () => {
  const source = readFileSync(join(import.meta.dir, '../../features/shell/SessionSidebar.tsx'), 'utf8');

  expect(source).toContain('createSidebarPagerGesture()');
  expect(source).toContain("host.addEventListener('scrollend', onScrollEnd)");
  expect(source).toContain("host.addEventListener('wheel', onWheel, { passive: false })");
  expect(source).toContain("overscrollBehaviorX: 'contain'");
  expect(source).toContain('host.scrollLeft = clamped');
  expect(source).toContain('const excess = desired - clamped');
  expect(source).toContain('sidebarTrackpadEdgeOffset(excess, edgeMaxPx)');
  expect(source).toContain('sidebarTrackpadEdgeAccum(trackpadFeedback.get(), edgeMaxPx)');
  expect(source).toContain('finishPageTurn(result.dragPx)');
  expect(source).toContain('pagerGestureRef.current.swallowTail(performance.now(), 0)');
  expect(source).toContain('const TRACKPAD_PAGE_TURN_THRESHOLD_RATIO = 0.4');
  expect(source).toContain('const threshold = width * TRACKPAD_PAGE_TURN_THRESHOLD_RATIO');
  expect(source).toContain('const TRACKPAD_EDGE_MARGIN_PX = 12');
  expect(source).toContain('duration: PANEL_SNAP_SCROLL_DURATION_S');
  expect(source).toContain('animate(trackpadFeedback, 0');
  expect(source).toContain("type: 'spring'");
  expect(source).toContain('rotateY: trackpadBounceRotateY');
  expect(source).toContain('transformOrigin: trackpadBounceOrigin');
  expect(source).toContain('transformPerspective: 1100');
  expect(source).toContain('x: trackpadBounceX');
  expect(source).toContain('data-sidebar-trackpad-surface="true"');
  expect(source.match(/panel-nav-snap-item/g)).toHaveLength(2);

  expect(source).not.toContain('scrollSnapType');
  expect(source).not.toContain('scroll-snap-align');
  expect(source).not.toContain("window.addEventListener('wheel'");
});

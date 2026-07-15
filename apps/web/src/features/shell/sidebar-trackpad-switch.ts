const HORIZONTAL_WHEEL_DOMINANCE = 0.85;
const HORIZONTAL_WHEEL_MIN_PX = 2;
const STREAM_QUIET_GAP_MS = 160;
const TRACKPAD_PAGE_TURN_THRESHOLD_RATIO = 0.4;
const DEFAULT_EDGE_MAX_PX = 300;
const EDGE_RUBBER_BAND_RESISTANCE_PX = 260;
const EDGE_ACCUM_CAP_PX = 780;
const MOMENTUM_DECAY_MAX_DELTA_PX = 40;
const MOMENTUM_DECAY_RELEASE_EVENTS = 4;
const FRESH_PUSH_MARGIN_PX = 4;

export function isSidebarHorizontalWheel({ deltaX, deltaY }: { deltaX: number; deltaY: number }): boolean {
  const horizontal = Math.abs(deltaX);
  return horizontal >= HORIZONTAL_WHEEL_MIN_PX && horizontal >= Math.abs(deltaY) * HORIZONTAL_WHEEL_DOMINANCE;
}

// iOS-style rubber band: monotonic, asymptotically approaching maxPx (the
// panel width + a small margin), so the panel keeps following the fingers all
// the way out of its container. Negative offset = panel pushed left.
export function sidebarTrackpadEdgeOffset(edgeDeltaX: number, maxPx: number = DEFAULT_EDGE_MAX_PX): number {
  if (edgeDeltaX === 0) return 0;
  const capped = Math.max(-EDGE_ACCUM_CAP_PX, Math.min(EDGE_ACCUM_CAP_PX, edgeDeltaX));
  const travel = maxPx * (1 - Math.exp(-Math.abs(capped) / EDGE_RUBBER_BAND_RESISTANCE_PX));
  return capped > 0 ? -travel : travel;
}

// Inverse of the rubber band: the accumulated finger travel that produces a
// given offset. Used to re-engage a gesture mid-spring without a jump.
export function sidebarTrackpadEdgeAccum(offsetPx: number, maxPx: number = DEFAULT_EDGE_MAX_PX): number {
  if (offsetPx === 0 || maxPx <= 0) return 0;
  const ratio = Math.min(Math.abs(offsetPx) / maxPx, 0.999);
  const accumulated = Math.min(-EDGE_RUBBER_BAND_RESISTANCE_PX * Math.log(1 - ratio), EDGE_ACCUM_CAP_PX);
  return offsetPx > 0 ? -accumulated : accumulated;
}

export type SidebarPagerUpdate =
  | { dragPx: number; kind: 'drag' }
  | { dragPx: number; kind: 'settle' }
  | { dragPx: 0; kind: 'swallowed' };

export type SidebarPagerSurface = 'archived' | 'settings' | 'studio' | 'workspace';

export function resolveSidebarPagerTarget({
  clientWidth,
  dragOrigin,
  dragPxTotal,
  pageCount = 2,
  scrollLeft
}: {
  clientWidth: number;
  dragOrigin: number;
  dragPxTotal: number;
  pageCount?: number;
  scrollLeft: number;
}): number {
  const width = clientWidth || 1;
  const originPage = Math.round(dragOrigin / width);
  const threshold = width * TRACKPAD_PAGE_TURN_THRESHOLD_RATIO;
  let targetPage: number;
  if (dragPxTotal > threshold) targetPage = originPage + 1;
  else if (dragPxTotal < -threshold) targetPage = originPage - 1;
  else targetPage = Math.round(scrollLeft / width);
  return Math.max(0, Math.min(Math.max(1, pageCount) - 1, targetPage));
}

// The pager owns the whole horizontal wheel stream: native scroll-snap is off,
// so paging stays deterministic — drag follows the fingers 1:1, release picks
// a page immediately, and the momentum tail can never re-animate anything.
export function createSidebarPagerGesture() {
  let dragging = false;
  let dragPx = 0;
  let lastEventAt = 0;
  let swallowedUntil = 0;
  let swallowedAbsDelta = 0;
  let lastAbsDelta = 0;
  let lastSign = 0;
  let decayCount = 0;

  const resetMomentumTracking = () => {
    lastAbsDelta = 0;
    lastSign = 0;
    decayCount = 0;
  };

  // Wheel streams have no "fingers lifted" signal — after a fast push the
  // stream continues with decaying momentum deltas for up to ~2s. A run of
  // strictly-shrinking small deltas is that tail: settle the page turn right
  // there and swallow the rest.
  const isMomentumTail = (nextDeltaX: number): boolean => {
    const abs = Math.abs(nextDeltaX);
    const sign = Math.sign(nextDeltaX);
    if (sign !== lastSign) {
      lastSign = sign;
      lastAbsDelta = abs;
      decayCount = 0;
      return false;
    }
    if (abs < lastAbsDelta && abs <= MOMENTUM_DECAY_MAX_DELTA_PX) decayCount += 1;
    else if (abs > lastAbsDelta) decayCount = 0;
    lastAbsDelta = abs;
    return decayCount >= MOMENTUM_DECAY_RELEASE_EVENTS;
  };

  // A momentum tail only ever decays. A delta that grows past what the tail
  // was last doing means the fingers re-engaged — the swallow state must yield
  // to it immediately instead of making the user wait out the quiet gap.
  const isFreshPush = (nextDeltaX: number): boolean => {
    const abs = Math.abs(nextDeltaX);
    if (abs > swallowedAbsDelta + FRESH_PUSH_MARGIN_PX) return true;
    swallowedAbsDelta = abs;
    return false;
  };

  return {
    reset() {
      dragging = false;
      dragPx = 0;
      swallowedUntil = 0;
      resetMomentumTracking();
    },
    swallowTail(now: number, deltaX: number) {
      swallowedUntil = now + STREAM_QUIET_GAP_MS;
      swallowedAbsDelta = Math.abs(deltaX);
      dragging = false;
      dragPx = 0;
      lastEventAt = now;
      resetMomentumTracking();
    },
    update({ deltaX, now, seedPx = 0 }: { deltaX: number; now: number; seedPx?: number }): SidebarPagerUpdate {
      const staleStream = now - lastEventAt > STREAM_QUIET_GAP_MS;
      lastEventAt = now;
      if (staleStream) {
        swallowedUntil = 0;
        dragging = false;
      }

      if (now < swallowedUntil) {
        if (isFreshPush(deltaX)) {
          swallowedUntil = 0;
        } else {
          swallowedUntil = now + STREAM_QUIET_GAP_MS;
          return { dragPx: 0, kind: 'swallowed' };
        }
      }

      if (!dragging) {
        dragging = true;
        dragPx = seedPx;
        resetMomentumTracking();
      }

      if (isMomentumTail(deltaX)) {
        const total = dragPx;
        this.swallowTail(now, deltaX);
        return { dragPx: total, kind: 'settle' };
      }

      dragPx += deltaX;
      return { dragPx, kind: 'drag' };
    }
  };
}

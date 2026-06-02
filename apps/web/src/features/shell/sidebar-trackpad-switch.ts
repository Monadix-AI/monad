const HORIZONTAL_WHEEL_DOMINANCE = 0.85;
const HORIZONTAL_WHEEL_MIN_PX = 2;
const STREAM_QUIET_GAP_MS = 160;
const TRACKPAD_PAGE_TURN_THRESHOLD_RATIO = 0.4;
const DEFAULT_EDGE_MAX_PX = 300;
const EDGE_RUBBER_BAND_RESISTANCE_PX = 260;
const EDGE_ACCUM_CAP_PX = 780;
const MOMENTUM_DECAY_MAX_DELTA_PX = 40;
const MOMENTUM_DECAY_RELEASE_EVENTS = 4;
const FRESH_PUSH_MARGIN_PX = 12;
const FRESH_PUSH_GROWTH_RATIO = 1.5;
export const FRESH_PUSH_REVERSE_MIN_PX = 8;

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

export function sidebarPageTurnThresholdPx(clientWidth: number): number {
  return (clientWidth || 1) * TRACKPAD_PAGE_TURN_THRESHOLD_RATIO;
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
  const threshold = sidebarPageTurnThresholdPx(width);
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
  let swallowedSign = 0;
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

  // A momentum tail only ever decays and never flips direction. Fingers
  // re-engaging show up as either a reversed delta or a delta clearly above
  // the decaying envelope — the swallow state must yield to those immediately.
  // The growth gate is deliberately generous: tail deltas are noisy, and a
  // small bump past the previous event must NOT re-open the drag (it reads as
  // the panel shivering at its settled endpoint).
  const isFreshPush = (nextDeltaX: number): boolean => {
    const abs = Math.abs(nextDeltaX);
    const sign = Math.sign(nextDeltaX);
    if (swallowedSign !== 0 && sign !== 0 && sign !== swallowedSign && abs >= FRESH_PUSH_REVERSE_MIN_PX) return true;
    const growthGate = Math.max(swallowedAbsDelta * FRESH_PUSH_GROWTH_RATIO, swallowedAbsDelta + FRESH_PUSH_MARGIN_PX);
    if (abs > growthGate) return true;
    // The envelope only ever ratchets DOWN. Following it up would chase a
    // deliberate accelerating re-push (each growing event raises the gate ahead
    // of the next one) and swallow the user's gesture until the quiet gap.
    swallowedAbsDelta = Math.min(swallowedAbsDelta, abs);
    if (sign !== 0) swallowedSign = sign;
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
      swallowedSign = Math.sign(deltaX);
      dragging = false;
      dragPx = 0;
      lastEventAt = now;
      resetMomentumTracking();
    },
    update({
      deltaX,
      now,
      seedPx = 0,
      settleThresholdPx
    }: {
      deltaX: number;
      now: number;
      seedPx?: number;
      settleThresholdPx?: number;
    }): SidebarPagerUpdate {
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

      // A decay run only settles once the drag has clearly committed to a page
      // turn. Below the threshold the tail keeps panning the panel (it may still
      // cross the threshold and settle later); a sub-threshold gesture is left
      // to the caller's release timer, so a finger merely slowing down never
      // snaps the panel out from under the user mid-drag.
      if (isMomentumTail(deltaX) && (settleThresholdPx === undefined || Math.abs(dragPx) >= settleThresholdPx)) {
        const total = dragPx;
        this.swallowTail(now, deltaX);
        return { dragPx: total, kind: 'settle' };
      }

      dragPx += deltaX;
      return { dragPx, kind: 'drag' };
    }
  };
}

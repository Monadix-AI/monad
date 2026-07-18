export const SIDEBAR_SESSION_TITLE_DELAY_MS = 600;
export const SIDEBAR_SESSION_TITLE_FADE_PX = 20;
export const SIDEBAR_SESSION_TITLE_SPEED_PX_PER_SECOND = 40;

export type SidebarSessionTitleMotionInput = {
  actionWidth: number;
  titleWidth: number;
  viewportWidth: number;
};

export type SidebarSessionTitleMotion = {
  distancePx: number;
  durationMs: number;
  overflowing: boolean;
};

export function getSidebarSessionTitleMotion({
  actionWidth,
  titleWidth,
  viewportWidth
}: SidebarSessionTitleMotionInput): SidebarSessionTitleMotion {
  const readableWidth = Math.max(0, viewportWidth - Math.max(0, actionWidth) - SIDEBAR_SESSION_TITLE_FADE_PX);
  const distancePx = Math.max(0, titleWidth - readableWidth);

  return {
    distancePx,
    durationMs: distancePx === 0 ? 0 : (distancePx / SIDEBAR_SESSION_TITLE_SPEED_PX_PER_SECOND) * 1000,
    overflowing: distancePx > 0
  };
}

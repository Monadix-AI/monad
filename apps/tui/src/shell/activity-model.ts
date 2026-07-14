const ACTIVITY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function activityFrame(tick: number): string {
  return ACTIVITY_FRAMES[Math.abs(tick) % ACTIVITY_FRAMES.length] ?? ACTIVITY_FRAMES[0];
}

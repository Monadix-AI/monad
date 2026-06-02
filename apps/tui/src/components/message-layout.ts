export const MESSAGE_SPEAKER_WIDTH = 14;

export function messageContentWidth(totalWidth: number): number {
  return Math.max(1, Math.floor(totalWidth) - MESSAGE_SPEAKER_WIDTH);
}

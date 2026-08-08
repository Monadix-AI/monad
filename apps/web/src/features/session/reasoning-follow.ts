export type ReasoningFollowEvent = 'content-appended' | 'user-scroll';

export function nextReasoningFollowState(following: boolean, event: ReasoningFollowEvent): boolean {
  return event === 'user-scroll' ? false : following;
}

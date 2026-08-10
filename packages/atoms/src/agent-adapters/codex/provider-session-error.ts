// Only a failure that names the session/thread itself is evidence the native record is gone. A bare
// "not found" also comes out of a missing executable or a missing model, and reporting those as a
// deleted session sends the user looking in the wrong place.
export function codexProviderSessionUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(?:session|thread|conversation|rollout)/i.test(message)) return false;
  return /(?:not found|does not exist|no such|deleted|archiv)/i.test(message);
}

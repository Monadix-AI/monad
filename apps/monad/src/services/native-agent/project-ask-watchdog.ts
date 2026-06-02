const REQUIRED_ASK_INTERRUPT_GRACE_MS = 2_000;
const REQUIRED_ASK_STOP_GRACE_MS = 8_000;

interface RequiredAskWatchdogEntry {
  requestId: string;
  projectId: string;
  projectSessionId: string;
  memberInstanceId: string;
  meshSessionId: string;
}

type TimerHandle = unknown;

interface RequiredAskWatchdogDeps {
  gateMatches: (entry: RequiredAskWatchdogEntry) => boolean;
  isTurnActive: (entry: RequiredAskWatchdogEntry) => boolean;
  interrupt: (meshSessionId: string) => void;
  stop: (meshSessionId: string) => void;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
}

export function createNativeAgentProjectAskWatchdog(deps: RequiredAskWatchdogDeps) {
  const schedule = deps.schedule ?? setTimeout;
  const unref = (timer: TimerHandle) => {
    if (
      typeof timer === 'object' &&
      timer &&
      'unref' in timer &&
      typeof (timer as { unref?: unknown }).unref === 'function'
    ) {
      (timer as { unref: () => void }).unref();
    }
  };
  const stillStuck = (entry: RequiredAskWatchdogEntry) => deps.gateMatches(entry) && deps.isTurnActive(entry);
  return {
    arm(entry: RequiredAskWatchdogEntry): void {
      const interruptTimer = schedule(() => {
        if (!stillStuck(entry)) return;
        deps.interrupt(entry.meshSessionId);
        const stopTimer = schedule(() => {
          if (stillStuck(entry)) deps.stop(entry.meshSessionId);
        }, REQUIRED_ASK_STOP_GRACE_MS);
        unref(stopTimer);
      }, REQUIRED_ASK_INTERRUPT_GRACE_MS);
      unref(interruptTimer);
    }
  };
}

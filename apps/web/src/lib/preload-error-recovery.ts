const PRELOAD_RELOAD_KEY = 'monad:preload-reload-at';
const PRELOAD_RELOAD_COOLDOWN_MS = 10_000;

interface PreloadRecoveryTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  location: { reload(): void };
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
}

export function installPreloadErrorRecovery(
  target: PreloadRecoveryTarget = window as unknown as PreloadRecoveryTarget,
  now: () => number = Date.now
): void {
  target.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    const currentTime = now();
    let lastReloadAt: number | undefined;
    try {
      const stored = target.sessionStorage.getItem(PRELOAD_RELOAD_KEY);
      if (stored !== null) lastReloadAt = Number(stored);
    } catch {}
    if (lastReloadAt !== undefined && currentTime - lastReloadAt < PRELOAD_RELOAD_COOLDOWN_MS) return;
    try {
      target.sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(currentTime));
    } catch {}
    target.location.reload();
  });
}

// Single-ref bus that lets the HTTP layer trigger graceful shutdown without importing serve.ts
// (which would create a circular dependency). serve.ts registers the handler once at startup;
// the daemon-ctl HTTP route calls trigger() — a no-op until registration completes.
let _fn: (() => void) | null = null;

export const shutdownBus = {
  register: (fn: () => void): void => {
    _fn = fn;
  },
  trigger: (): void => {
    _fn?.();
  }
};

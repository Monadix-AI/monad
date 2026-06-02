export interface ReloadScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface ReloadCoordinatorOptions {
  apply: () => Promise<void>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
}

const defaultScheduler: ReloadScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class ReloadCoordinator {
  private readonly apply: () => Promise<void>;
  private readonly debounceMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly scheduler: ReloadScheduler;
  private active: Promise<void> = Promise.resolve();
  private applying = false;
  private dirty = false;
  private stopped = false;
  private timer: unknown;

  constructor(options: ReloadCoordinatorOptions) {
    this.apply = options.apply;
    this.debounceMs = options.debounceMs ?? 150;
    this.onError = options.onError ?? (() => {});
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  request(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.applying) return;
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.stopped) return;
    this.cancelTimer();
    if (this.applying) await this.active;
    if (this.stopped || !this.dirty) return;

    this.dirty = false;
    this.applying = true;
    const run = Promise.resolve().then(this.apply);
    this.active = run.catch(() => {});
    try {
      await run;
    } finally {
      this.applying = false;
      if (this.dirty && !this.stopped) this.schedule();
    }
  }

  async whenIdle(): Promise<void> {
    await this.active;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.dirty = false;
    this.cancelTimer();
    await this.active;
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = this.scheduler.set(() => {
      this.timer = undefined;
      void this.flush().catch(this.onError);
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clear(this.timer);
    this.timer = undefined;
  }
}

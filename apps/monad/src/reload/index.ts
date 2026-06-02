// The watch primitive is injectable so debounce/filter/dispatch logic is unit-testable
// without touching the real filesystem.

import { watch } from 'node:fs';

/** Minimal handle a watcher returns — `node:fs` FSWatcher satisfies this. */
export interface WatchHandle {
  close(): void;
}

/** The watch primitive ReloadService builds on. Defaults to `node:fs` watch. */
export type WatchFn = (
  path: string,
  options: { persistent: boolean; recursive?: boolean },
  listener: (event: string, filename: string | null) => void
) => WatchHandle;

export interface ReloadSource {
  /** Human label, used in logs and to key this source's debounce timer. */
  name: string;
  /** File or directory to watch. A missing path is logged and skipped (non-fatal). */
  path: string;
  /** Watch subdirectories — needed for nested layouts (e.g. skills/<name>/SKILL.md). Default false. */
  recursive?: boolean;
  /** Debounce window before firing onChange, coalescing bursts of events. Default 150ms. */
  debounceMs?: number;
  /** Optional filter on the changed filename; return false to ignore the event. */
  filter?: (filename: string | null) => boolean;
  /** Reload logic. Errors are caught and logged, never thrown. */
  onChange: () => void | Promise<void>;
}

export interface ReloadServiceDeps {
  log: (level: 'info' | 'warn', message: string) => void;
  /** Override the watch primitive (tests inject a fake). Defaults to `node:fs` watch. */
  watchFn?: WatchFn;
}

const DEFAULT_DEBOUNCE_MS = 150;

export class ReloadService {
  private readonly watchFn: WatchFn;
  private readonly handles: WatchHandle[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ReloadServiceDeps) {
    this.watchFn = deps.watchFn ?? (watch as unknown as WatchFn);
  }

  /** Returns true if the watcher started; a non-watchable path is logged and skipped. */
  register(source: ReloadSource): boolean {
    const debounceMs = source.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const listener = (_event: string, filename: string | null) => this._dispatch(source, debounceMs, filename);
    try {
      let handle: WatchHandle;
      try {
        handle = this.watchFn(source.path, { persistent: false, recursive: source.recursive ?? false }, listener);
      } catch (recursiveErr) {
        // Linux/inotify doesn't support recursive directory watches — fall back to top-level only
        // so changes to pack directories one level deep (the common layout) still trigger reloads.
        if (!source.recursive) throw recursiveErr;
        handle = this.watchFn(source.path, { persistent: false, recursive: false }, listener);
        this.deps.log(
          'warn',
          `reload watcher "${source.name}": recursive watch not supported on this platform — watching top-level only`
        );
      }
      this.handles.push(handle);
      return true;
    } catch (err) {
      this.deps.log(
        'warn',
        `reload watcher "${source.name}" not started: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  private _dispatch(source: ReloadSource, debounceMs: number, filename: string | null): void {
    if (source.filter && !source.filter(filename)) return;
    const pending = this.timers.get(source.name);
    if (pending) clearTimeout(pending);
    this.timers.set(
      source.name,
      setTimeout(() => {
        this.timers.delete(source.name);
        void Promise.resolve()
          .then(source.onChange)
          .catch((err: unknown) =>
            this.deps.log('warn', `reload "${source.name}" failed: ${err instanceof Error ? err.message : String(err)}`)
          );
      }, debounceMs)
    );
  }

  closeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const handle of this.handles) handle.close();
    this.handles.length = 0;
  }
}

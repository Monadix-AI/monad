import type { MonadAuth, MonadConfig } from '@monad/home';
import type { ReloadScheduler } from './reload.ts';

import { ReloadCoordinator } from './reload.ts';

export interface ConfigSnapshot {
  cfg: MonadConfig;
  auth: MonadAuth | null;
}

export interface ConfigSource {
  load(): Promise<ConfigSnapshot | null>;
  saveConfig(cfg: MonadConfig): Promise<void>;
  saveAuth(auth: MonadAuth): Promise<void>;
  watch?(onChange: () => void): () => void;
}

export interface ConfigServiceOptions {
  initial: ConfigSnapshot;
  source: ConfigSource;
  apply: (snapshot: ConfigSnapshot) => Promise<void>;
  debounceMs?: number;
  equals?: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  onError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
}

const jsonEquals = (a: ConfigSnapshot, b: ConfigSnapshot): boolean => JSON.stringify(a) === JSON.stringify(b);

export class ConfigService {
  private readonly apply: (snapshot: ConfigSnapshot) => Promise<void>;
  private readonly coordinator: ReloadCoordinator;
  private readonly equals: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  private readonly source: ConfigSource;
  private current: ConfigSnapshot;
  private unsubscribe?: () => void;

  constructor(options: ConfigServiceOptions) {
    this.apply = options.apply;
    this.current = options.initial;
    this.equals = options.equals ?? jsonEquals;
    this.source = options.source;
    this.coordinator = new ReloadCoordinator({
      apply: () => this.applyLatest(),
      debounceMs: options.debounceMs,
      onError: options.onError,
      scheduler: options.scheduler
    });
  }

  get(): ConfigSnapshot {
    return this.current;
  }

  refresh(): void {
    this.coordinator.request();
  }

  async refreshNow(): Promise<ConfigSnapshot> {
    this.refresh();
    await this.coordinator.flush();
    return this.current;
  }

  whenIdle(): Promise<void> {
    return this.coordinator.whenIdle();
  }

  startWatching(): void {
    if (this.unsubscribe || !this.source.watch) return;
    this.unsubscribe = this.source.watch(() => this.refresh());
  }

  async updateConfig(mutate: (cfg: MonadConfig) => MonadConfig): Promise<ConfigSnapshot> {
    await this.source.saveConfig(mutate(this.current.cfg));
    return this.refreshNow();
  }

  async updateAuth(mutate: (auth: MonadAuth | null) => MonadAuth): Promise<ConfigSnapshot> {
    await this.source.saveAuth(mutate(this.current.auth));
    return this.refreshNow();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.coordinator.stop();
  }

  private async applyLatest(): Promise<void> {
    const next = await this.source.load();
    if (!next || this.equals(this.current, next)) return;
    await this.apply(next);
    this.current = next;
  }
}

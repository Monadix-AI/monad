import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { ReloadScheduler } from './reload.ts';

import { monadAuthSchema, monadConfigSchema } from '@monad/environment';

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

export interface ConfigManagerOptions {
  initial: ConfigSnapshot;
  source: ConfigSource;
  apply: (snapshot: ConfigSnapshot) => Promise<void>;
  debounceMs?: number;
  equals?: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  onError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
}

export interface ConfigManagerStatus {
  state: 'ready' | 'applying' | 'error' | 'stopped';
  lastError?: unknown;
}

type ConfigMutation = (cfg: MonadConfig) => MonadConfig | undefined | Promise<MonadConfig | undefined>;
type AuthMutation = (auth: MonadAuth | null) => MonadAuth | Promise<MonadAuth>;
type SnapshotMutation = (snapshot: ConfigSnapshot) => ConfigSnapshot | undefined | Promise<ConfigSnapshot | undefined>;

interface Subscription<T = unknown> {
  select(snapshot: ConfigSnapshot): T;
  listener(next: T, previous: T): void;
  value: T;
}

const jsonEquals = (a: ConfigSnapshot, b: ConfigSnapshot): boolean => JSON.stringify(a) === JSON.stringify(b);

export class ConfigManager {
  static async load(source: ConfigSource): Promise<ConfigSnapshot> {
    const snapshot = await source.load();
    if (!snapshot) throw new Error('monad: settings files are missing after repair - aborting');
    return {
      cfg: monadConfigSchema.parse(snapshot.cfg),
      auth: snapshot.auth === null ? null : monadAuthSchema.parse(snapshot.auth)
    };
  }

  private readonly apply: (snapshot: ConfigSnapshot) => Promise<void>;
  private readonly coordinator: ReloadCoordinator;
  private readonly equals: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  private readonly source: ConfigSource;
  private readonly subscriptions = new Set<Subscription>();
  private current: ConfigSnapshot;
  private operation: Promise<void> = Promise.resolve();
  private state: ConfigManagerStatus = { state: 'ready' };
  private unsubscribe?: () => void;

  constructor(options: ConfigManagerOptions) {
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

  status(): ConfigManagerStatus {
    return this.state;
  }

  subscribe<T>(select: (snapshot: ConfigSnapshot) => T, listener: (next: T, previous: T) => void): () => void {
    const subscription: Subscription<T> = { select, listener, value: select(this.current) };
    this.subscriptions.add(subscription as Subscription);
    return () => this.subscriptions.delete(subscription as Subscription);
  }

  refresh(): void {
    this.coordinator.request();
  }

  async refreshNow(): Promise<ConfigSnapshot> {
    await this.operation;
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

  updateConfig(mutate: ConfigMutation): Promise<ConfigSnapshot> {
    return this.update(async (draft) => {
      const result = await mutate(draft.cfg);
      if (result) draft.cfg = result;
    });
  }

  updateAuth(mutate: AuthMutation): Promise<ConfigSnapshot> {
    return this.update(async (draft) => {
      draft.auth = await mutate(draft.auth);
    });
  }

  update(mutate: SnapshotMutation): Promise<ConfigSnapshot> {
    return this.enqueue(async () => {
      const previous = this.current;
      const draft = structuredClone(previous);
      const result = await mutate(draft);
      const candidate = result ?? draft;
      const next: ConfigSnapshot = {
        cfg: monadConfigSchema.parse(candidate.cfg),
        auth: candidate.auth === null ? null : monadAuthSchema.parse(candidate.auth)
      };
      if (this.equals(previous, next)) return previous;

      const configChanged = !this.equals(previous, { ...previous, cfg: next.cfg });
      const authChanged = !this.equals(previous, { ...previous, auth: next.auth });
      if (configChanged) await this.source.saveConfig(next.cfg);
      if (authChanged && next.auth) await this.source.saveAuth(next.auth);
      try {
        await this.accept(next);
      } catch (error) {
        await Promise.all([
          configChanged ? this.source.saveConfig(previous.cfg).catch(() => {}) : Promise.resolve(),
          authChanged && previous.auth ? this.source.saveAuth(previous.auth).catch(() => {}) : Promise.resolve()
        ]);
        throw error;
      }
      return this.current;
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.coordinator.stop();
    await this.operation;
    this.subscriptions.clear();
    this.state = { state: 'stopped' };
  }

  private async applyLatest(): Promise<void> {
    const next = await this.source.load();
    if (!next || this.equals(this.current, next)) return;
    await this.enqueue(() => this.accept(next));
  }

  private async accept(next: ConfigSnapshot): Promise<void> {
    const previous = this.current;
    this.state = { state: 'applying' };
    try {
      await this.apply(next);
      this.current = next;
      this.state = { state: 'ready' };
      this.notify(previous, next);
    } catch (error) {
      this.state = { state: 'error', lastError: error };
      throw error;
    }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operation.then(run, run);
    this.operation = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  private notify(_previous: ConfigSnapshot, next: ConfigSnapshot): void {
    for (const subscription of this.subscriptions) {
      const previousValue = subscription.value;
      const nextValue = subscription.select(next);
      subscription.value = nextValue;
      if (!Object.is(previousValue, nextValue)) subscription.listener(nextValue, previousValue);
    }
  }
}

export type ConfigAccess = Pick<
  ConfigManager,
  'get' | 'status' | 'subscribe' | 'update' | 'updateAuth' | 'updateConfig'
>;

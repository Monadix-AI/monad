import type { MonadAuth, MonadConfig } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ConfigSnapshot, ConfigSource } from '#/config/service.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/home';

import { ConfigService } from '#/config/service.ts';
import { manualScheduler } from './helpers.ts';

function snapshot(model: string, auth: MonadAuth | null = null): ConfigSnapshot {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  return { auth, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function fakeSource(initial: ConfigSnapshot) {
  let watcher: (() => void) | undefined;
  const source: ConfigSource & {
    authSaves: string[];
    configSaves: string[];
    current: ConfigSnapshot | null;
    emit(): void;
    unsubscribes: number;
  } = {
    authSaves: [],
    configSaves: [],
    current: initial,
    unsubscribes: 0,
    emit: () => watcher?.(),
    load: async () => source.current,
    saveConfig: async (cfg: MonadConfig) => {
      source.configSaves.push(cfg.model.default);
      source.current = { auth: source.current?.auth ?? null, cfg };
    },
    saveAuth: async (auth: MonadAuth) => {
      source.authSaves.push(auth.namedSecrets?.token ?? 'none');
      source.current = { auth, cfg: source.current?.cfg ?? initial.cfg };
    },
    watch: (onChange) => {
      watcher = onChange;
      return () => {
        source.unsubscribes++;
        watcher = undefined;
      };
    }
  };
  return source;
}

test('applies only the latest snapshot after a burst', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.model.default)
  });

  source.current = snapshot('b');
  service.refresh();
  source.current = snapshot('c');
  service.refresh();
  clock.runNext();
  await service.whenIdle();

  expect(applied).toEqual(['c']);
  expect(service.get().cfg.model.default).toBe('c');
});

test('skips an unchanged snapshot', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.model.default)
  });

  service.refresh();
  clock.runNext();
  await service.whenIdle();

  expect(applied).toEqual([]);
  expect(service.get().cfg.model.default).toBe('a');
});

test('retains the accepted snapshot when apply fails', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const errors: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    onError: (error) => errors.push((error as Error).message),
    apply: async () => {
      throw new Error('apply failed');
    }
  });

  source.current = snapshot('b');
  service.refresh();
  clock.runNext();
  await service.whenIdle();

  expect({ errors, model: service.get().cfg.model.default }).toEqual({ errors: ['apply failed'], model: 'a' });
});

test('retains the accepted snapshot when the disk snapshot is temporarily unavailable', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.model.default)
  });

  source.current = null;
  service.refresh();
  clock.runNext();
  await service.whenIdle();

  expect({ applied, model: service.get().cfg.model.default }).toEqual({ applied: [], model: 'a' });
});

test('updateConfig saves then applies the disk snapshot before returning', async () => {
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    apply: async (next) => void applied.push(next.cfg.model.default)
  });

  const accepted = await service.updateConfig((cfg) => ({ ...cfg, model: { ...cfg.model, default: 'b' } }));

  expect({ applied, model: accepted.cfg.model.default, saves: source.configSaves }).toEqual({
    applied: ['b'],
    model: 'b',
    saves: ['b']
  });
});

test('updateAuth saves then applies the complete snapshot before returning', async () => {
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    apply: async (next) => void applied.push(next.auth?.namedSecrets?.token ?? 'none')
  });

  const accepted = await service.updateAuth(() => ({ ...emptyAuth(), namedSecrets: { token: 'secret' } }));

  expect({ applied, saves: source.authSaves, token: accepted.auth?.namedSecrets?.token }).toEqual({
    applied: ['secret'],
    saves: ['secret'],
    token: 'secret'
  });
});

test('watch events refresh until stop unsubscribes', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigService({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.model.default)
  });
  service.startWatching();

  source.current = snapshot('b');
  source.emit();
  clock.runNext();
  await service.whenIdle();
  await service.stop();
  source.current = snapshot('c');
  source.emit();

  expect({ applied, pending: clock.pendingCount(), unsubscribes: source.unsubscribes }).toEqual({
    applied: ['b'],
    pending: 0,
    unsubscribes: 1
  });
});

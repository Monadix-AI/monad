import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { ConfigSnapshot, ConfigSource } from '#/config/manager.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';

import { ConfigManager } from '#/config/manager.ts';
import { manualScheduler } from './helpers.ts';

function snapshot(model: string, auth: MonadAuth | null = null): ConfigSnapshot {
  const cfg = createDefaultConfig('Test');
  return { auth, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function authWithToken(secret: string): MonadAuth {
  const now = new Date().toISOString();
  return {
    ...emptyAuth(),
    credentials: {
      token: {
        label: 'Token',
        environmentVariable: 'TOKEN',
        secret,
        allowedHosts: ['example.com'],
        createdAt: now,
        updatedAt: now
      }
    }
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakeSource(initial: ConfigSnapshot, withSnapshot = false) {
  let watcher: (() => void) | undefined;
  const source: ConfigSource & {
    authSaves: string[];
    configSaves: string[];
    snapshotSaves: Array<{ model: string; token: string | undefined }>;
    current: ConfigSnapshot | null;
    emit(): void;
    unsubscribes: number;
  } = {
    authSaves: [],
    configSaves: [],
    snapshotSaves: [],
    current: initial,
    unsubscribes: 0,
    emit: () => watcher?.(),
    load: async () => source.current,
    saveConfig: async (cfg: MonadConfig) => {
      source.configSaves.push(cfg.model.default);
      source.current = { auth: source.current?.auth ?? null, cfg };
    },
    saveAuth: async (auth: MonadAuth) => {
      source.authSaves.push(auth.credentials.token?.secret ?? 'none');
      source.current = { auth, cfg: source.current?.cfg ?? initial.cfg };
    },
    ...(withSnapshot
      ? {
          saveSnapshot: async (_previous: ConfigSnapshot, next: ConfigSnapshot) => {
            source.snapshotSaves.push({
              model: next.cfg.model.default,
              token: next.auth?.credentials.token?.secret
            });
            source.current = next;
          }
        }
      : {}),
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
  const service = new ConfigManager({
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
  const service = new ConfigManager({
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

test('refreshNow applies the latest disk snapshot before returning', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigManager({
    initial: snapshot('a'),
    source,
    scheduler: clock.scheduler,
    apply: async (next) => void applied.push(next.cfg.model.default)
  });
  source.current = snapshot('b');

  await service.refreshNow();

  expect({ applied, model: service.get().cfg.model.default, pending: clock.pendingCount() }).toEqual({
    applied: ['b'],
    model: 'b',
    pending: 0
  });
});

test('retains the accepted snapshot when apply fails', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const errors: string[] = [];
  const service = new ConfigManager({
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
  const service = new ConfigManager({
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
  const service = new ConfigManager({
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

test('updateConfig uses the snapshot transaction when the source provides it', async () => {
  const source = fakeSource(snapshot('a'), true);
  const service = new ConfigManager({
    initial: snapshot('a'),
    source,
    apply: async () => {}
  });

  await service.updateConfig((cfg) => ({ ...cfg, model: { ...cfg.model, default: 'b' } }));

  expect({
    configSaves: source.configSaves,
    snapshotSaves: source.snapshotSaves
  }).toEqual({
    configSaves: [],
    snapshotSaves: [{ model: 'b', token: undefined }]
  });
});

test('updateAuth saves then applies the complete snapshot before returning', async () => {
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigManager({
    initial: snapshot('a'),
    source,
    apply: async (next) => void applied.push(next.auth?.credentials.token?.secret ?? 'none')
  });

  const accepted = await service.updateAuth(() => authWithToken('secret'));

  expect({ applied, saves: source.authSaves, token: accepted.auth?.credentials.token?.secret }).toEqual({
    applied: ['secret'],
    saves: ['secret'],
    token: 'secret'
  });
});

test('update commits config and auth as one accepted runtime snapshot', async () => {
  const source = fakeSource(snapshot('a'), true);
  const applied: Array<{ model: string; token: string | undefined }> = [];
  const service = new ConfigManager({
    initial: snapshot('a'),
    source,
    apply: async (next) => {
      applied.push({ model: next.cfg.model.default, token: next.auth?.credentials.token?.secret });
    }
  });

  const accepted = await service.update((draft) => {
    draft.cfg.model.default = 'b';
    draft.auth = authWithToken('secret');
  });

  expect({
    applied,
    authSaves: source.authSaves,
    configSaves: source.configSaves,
    snapshotSaves: source.snapshotSaves,
    accepted: {
      model: accepted.cfg.model.default,
      token: accepted.auth?.credentials.token?.secret
    }
  }).toEqual({
    applied: [{ model: 'b', token: 'secret' }],
    authSaves: [],
    configSaves: [],
    snapshotSaves: [{ model: 'b', token: 'secret' }],
    accepted: { model: 'b', token: 'secret' }
  });
});

test('update restores the complete previous snapshot when applying a multi-document change fails', async () => {
  const initial = snapshot('a', authWithToken('old-secret'));
  const source = fakeSource(initial, true);
  const service = new ConfigManager({
    initial,
    source,
    apply: async () => {
      throw new Error('apply failed');
    }
  });

  await expect(
    service.update((draft) => {
      draft.cfg.model.default = 'b';
      draft.auth = authWithToken('new-secret');
    })
  ).rejects.toThrow('apply failed');

  expect({
    accepted: {
      model: service.get().cfg.model.default,
      token: service.get().auth?.credentials.token?.secret
    },
    persisted: {
      model: source.current?.cfg.model.default,
      token: source.current?.auth?.credentials.token?.secret
    },
    snapshotSaves: source.snapshotSaves
  }).toEqual({
    accepted: { model: 'a', token: 'old-secret' },
    persisted: { model: 'a', token: 'old-secret' },
    snapshotSaves: [
      { model: 'b', token: 'new-secret' },
      { model: 'a', token: 'old-secret' }
    ]
  });
});

test('watch reload waits for every active snapshot transaction boundary before loading or recovering', async () => {
  const clock = manualScheduler();
  const initial = snapshot('a', authWithToken('old-secret'));
  const source = fakeSource(initial, true);
  const boundaries = ['prepared', 'agents-installed', 'auth-installed', 'committed', 'cleanup'] as const;
  const reached = boundaries.map(() => deferred());
  const releases = boundaries.map(() => deferred());
  let loads = 0;
  source.load = async () => {
    loads++;
    return source.current;
  };
  source.saveSnapshot = async (_previous, next) => {
    for (const [index] of boundaries.entries()) {
      reached[index]?.resolve();
      await releases[index]?.promise;
    }
    source.current = next;
  };
  const service = new ConfigManager({
    initial,
    source,
    scheduler: clock.scheduler,
    apply: async () => {}
  });
  service.startWatching();

  const update = service.update((draft) => {
    draft.cfg.model.default = 'b';
    draft.auth = authWithToken('new-secret');
  });
  const loadsAtBoundaries: number[] = [];
  for (const [index] of boundaries.entries()) {
    await reached[index]?.promise;
    source.emit();
    if (clock.pendingCount() > 0) clock.runNext();
    await Promise.resolve();
    loadsAtBoundaries.push(loads);
    releases[index]?.resolve();
  }
  await update;
  await service.whenIdle();
  await service.stop();

  expect({ loadsAtBoundaries, finalLoads: loads }).toEqual({
    loadsAtBoundaries: [0, 0, 0, 0, 0],
    finalLoads: 1
  });
});

test('watch events refresh until stop unsubscribes', async () => {
  const clock = manualScheduler();
  const source = fakeSource(snapshot('a'));
  const applied: string[] = [];
  const service = new ConfigManager({
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

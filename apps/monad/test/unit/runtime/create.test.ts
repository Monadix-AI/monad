import type { MonadAuth, MonadConfig } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ConfigSnapshot, ConfigSource } from '#/config/service.ts';
import type { RuntimeModule } from '#/runtime/types.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { createDaemonRuntime } from '#/runtime/create.ts';
import { manualScheduler } from '../config/helpers.ts';

interface RecordingSource extends ConfigSource {
  current: ConfigSnapshot;
  emit(): void;
}

function snapshot(model: string): ConfigSnapshot {
  const cfg = createDefaultConfig('usr_test' as PrincipalId, 'Test');
  return { auth: null, cfg: { ...cfg, model: { ...cfg.model, default: model } } };
}

function source(initial: ConfigSnapshot, events: string[]): RecordingSource {
  let watcher: (() => void) | undefined;
  const configSource: RecordingSource = {
    current: initial,
    emit: () => watcher?.(),
    load: async () => configSource.current,
    saveConfig: async (cfg: MonadConfig) => {
      configSource.current = { ...configSource.current, cfg };
    },
    saveAuth: async (auth: MonadAuth) => {
      configSource.current = { ...configSource.current, auth };
    },
    watch: (onChange) => {
      events.push('config:watch');
      watcher = onChange;
      return () => {
        events.push('config:unwatch');
        watcher = undefined;
      };
    }
  };
  return configSource;
}

function recordingModule(events: string[], initialModel = 'a'): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'model',
    criticality: 'required',
    start: async () => {
      events.push(`module:start:${initialModel}`);
      return initialModel;
    },
    reload: async (_current, next) => {
      events.push(`module:reload:${next.cfg.model.default}`);
      return next.cfg.model.default;
    },
    stop: async () => void events.push('module:stop')
  };
}

test('starts modules before enabling config watching', async () => {
  const events: string[] = [];
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    source: source(snapshot('a'), events)
  });

  await runtime.start();

  expect(events).toEqual(['module:start:a', 'config:watch']);
  await runtime.stop();
});

test('routes the latest accepted config snapshot through kernel reload', async () => {
  const events: string[] = [];
  const clock = manualScheduler();
  const configSource = source(snapshot('a'), events);
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    scheduler: clock.scheduler,
    source: configSource
  });
  await runtime.start();
  configSource.current = snapshot('b');
  configSource.emit();
  clock.runNext();
  await runtime.config.whenIdle();

  expect(events).toEqual(['module:start:a', 'config:watch', 'module:reload:b']);
  expect(runtime.config.get().cfg.model.default).toBe('b');
  await runtime.stop();
});

test('stops watching before stopping modules', async () => {
  const events: string[] = [];
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    source: source(snapshot('a'), events)
  });
  await runtime.start();

  await runtime.stop();

  expect(events).toEqual(['module:start:a', 'config:watch', 'config:unwatch', 'module:stop']);
});

test('rolls back modules when watcher startup fails', async () => {
  const events: string[] = [];
  const configSource = source(snapshot('a'), events);
  configSource.watch = () => {
    throw new Error('watch failed');
  };
  const runtime = createDaemonRuntime({
    initial: snapshot('a'),
    modules: [recordingModule(events)],
    source: configSource
  });

  await expect(runtime.start()).rejects.toThrow('watch failed');
  expect(events).toEqual(['module:start:a', 'module:stop']);
});

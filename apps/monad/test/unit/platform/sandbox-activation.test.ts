import type { SandboxBackendRef, SandboxLauncher, SandboxProcess } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';
import { configureSandboxLauncher, noneLauncher, sandboxedSpawn, sandboxLauncher } from '@monad/sandbox';

import { createSandboxActivationService } from '#/platform/sandbox/activation.ts';
import { serializeSandboxBackendRef } from '#/platform/sandbox/backend-settings.ts';

afterEach(() => configureSandboxLauncher(noneLauncher));

const oldRef = { source: 'builtin', kind: 'old' } as const;
const nextRef = { source: 'atom-pack', packId: 'vendor', kind: 'next' } as const;
const autoRef = { source: 'builtin', kind: 'auto' } as const;

function launcher(
  kind: string,
  hooks: {
    configure?: (settings: Record<string, unknown>) => void | Promise<void>;
    descriptor?: SandboxLauncher['descriptor'];
    prepare?: () => void | Promise<void>;
    available?: () => boolean;
    disposeIdle?: () => void | Promise<void>;
    spawn?: (owner: string) => SandboxProcess;
  } = {}
): SandboxLauncher {
  return {
    kind,
    descriptor: hooks.descriptor ?? { name: kind },
    configure: hooks.configure,
    prepare: hooks.prepare ? async () => hooks.prepare?.() : undefined,
    isAvailable: hooks.available,
    disposeIdle: hooks.disposeIdle,
    ...(hooks.spawn
      ? { spawn: () => hooks.spawn?.(kind) as SandboxProcess }
      : { wrap: (argv: string[]) => [`${kind}:`, ...argv] })
  };
}

function fixture(options: { persist?: () => Promise<void>; old?: SandboxLauncher; next?: SandboxLauncher } = {}) {
  let snapshot = {
    cfg: createDefaultConfig('Test'),
    auth: emptyAuth()
  };
  snapshot.cfg.sandbox.activeBackend = oldRef;
  const old = options.old ?? launcher('old');
  const next = options.next ?? launcher('next');
  const auto = launcher('auto');
  const launchers = new Map<string, SandboxLauncher>([
    [serializeSandboxBackendRef(oldRef), old],
    [serializeSandboxBackendRef(nextRef), next],
    [serializeSandboxBackendRef(autoRef), auto]
  ]);
  configureSandboxLauncher(old);

  const service = createSandboxActivationService({
    platform: 'linux',
    load: async () => structuredClone(snapshot),
    persist: async (nextSnapshot) => {
      await options.persist?.();
      snapshot = structuredClone(nextSnapshot);
    },
    resolveLauncher: (ref) => launchers.get(serializeSandboxBackendRef(ref))
  });
  return {
    service,
    get snapshot() {
      return snapshot;
    },
    old,
    next,
    auto,
    setLauncher: (ref: SandboxBackendRef, value: SandboxLauncher) => {
      launchers.set(serializeSandboxBackendRef(ref), value);
    }
  };
}

test('configures and prepares a candidate before one atomic runtime swap and persistence', async () => {
  const calls: string[] = [];
  const next = launcher('next', {
    configure: () => {
      calls.push('configure');
    },
    prepare: () => {
      calls.push('prepare');
    },
    available: () => {
      calls.push('probe');
      return true;
    }
  });
  const f = fixture({ next });

  const result = await f.service.activateBackend(nextRef);

  expect(result).toMatchObject({ status: 'active', requested: nextRef, effective: nextRef });
  expect(calls).toEqual(['configure', 'prepare', 'probe']);
  expect(sandboxLauncher()).toBe(next);
  expect(f.snapshot.cfg.sandbox.activeBackend).toEqual(nextRef);
});

test('prepare failure and unavailable candidates retain the old runtime and config', async () => {
  let f = fixture({ next: launcher('next', { prepare: () => Promise.reject(new Error('prepare failed')) }) });
  let result = await f.service.activateBackend(nextRef);
  expect(result).toMatchObject({ status: 'error', error: 'prepare failed' });
  expect(sandboxLauncher()).toBe(f.old);
  expect(f.snapshot.cfg.sandbox.activeBackend).toEqual(oldRef);

  f = fixture({ next: launcher('next', { available: () => false }) });
  result = await f.service.activateBackend(nextRef);
  expect(result).toMatchObject({ status: 'error' });
  expect(result.error).toContain('unavailable');
  expect(sandboxLauncher()).toBe(f.old);
});

test('persistence failure swaps the runtime back to the old launcher', async () => {
  const f = fixture({ persist: async () => Promise.reject(new Error('disk full')) });
  const result = await f.service.activateBackend(nextRef);

  expect(result).toMatchObject({ status: 'error', error: 'disk full', effective: oldRef });
  expect(sandboxLauncher()).toBe(f.old);
  expect(f.snapshot.cfg.sandbox.activeBackend).toEqual(oldRef);
});

test('persistence failure restores settings when reconfiguring the active launcher', async () => {
  const configured: unknown[] = [];
  const old = launcher('old', {
    descriptor: {
      name: 'old',
      settings: { fields: [{ id: 'image', type: 'string', label: 'Image' }] }
    },
    configure: (settings) => {
      configured.push(settings.image);
    }
  });
  const f = fixture({ old, persist: async () => Promise.reject(new Error('disk full')) });
  f.snapshot.cfg.sandbox.backendSettings[serializeSandboxBackendRef(oldRef)] = { image: 'old-image' };

  const result = await f.service.activateBackend(oldRef, { values: { image: 'next-image' } });

  expect(result).toMatchObject({ status: 'error', error: 'disk full', effective: oldRef });
  expect(configured).toEqual(['next-image', 'old-image']);
  expect(sandboxLauncher()).toBe(old);
});

test('active launcher restoration errors redact previously stored secrets', async () => {
  const configured: unknown[] = [];
  const old = launcher('old', {
    descriptor: {
      name: 'old',
      settings: { fields: [{ id: 'apiKey', type: 'secret', label: 'API key', required: true }] }
    },
    configure: (settings) => {
      configured.push(settings.apiKey);
      if (settings.apiKey === 'old-secret') throw new Error(`restore failed for ${settings.apiKey}`);
    }
  });
  const f = fixture({ old, persist: async () => Promise.reject(new Error('disk full')) });
  f.snapshot.cfg.sandbox.backendSettings[serializeSandboxBackendRef(oldRef)] = {
    apiKey: ['$', '{secret:sandbox/builtin/old/apiKey}'].join('')
  };
  f.snapshot.auth.namedSecrets = { 'sandbox/builtin/old/apiKey': 'old-secret' };

  const result = await f.service.activateBackend(oldRef, {
    secrets: { apiKey: { action: 'replace', value: 'next-secret' } }
  });

  expect(configured).toEqual(['next-secret', 'old-secret']);
  expect(result.error).toContain('[redacted]');
  expect(result.error).not.toContain('old-secret');
});

test('persistence errors redact newly submitted sandbox secrets', async () => {
  const old = launcher('old', {
    descriptor: {
      name: 'old',
      settings: { fields: [{ id: 'apiKey', type: 'secret', label: 'API key', required: true }] }
    }
  });
  const f = fixture({ old, persist: async () => Promise.reject(new Error('persist failed for next-secret')) });
  f.snapshot.cfg.sandbox.backendSettings[serializeSandboxBackendRef(oldRef)] = {
    apiKey: ['$', '{secret:sandbox/builtin/old/apiKey}'].join('')
  };
  f.snapshot.auth.namedSecrets = { 'sandbox/builtin/old/apiKey': 'old-secret' };

  const result = await f.service.activateBackend(oldRef, {
    secrets: { apiKey: { action: 'replace', value: 'next-secret' } }
  });

  expect(result.error).toContain('[redacted]');
  expect(result.error).not.toContain('next-secret');
  expect(result.error).not.toContain('old-secret');
});

test('persistence errors redact secrets from the previous launcher', async () => {
  const old = launcher('old', {
    descriptor: {
      name: 'old',
      settings: { fields: [{ id: 'apiKey', type: 'secret', label: 'API key', required: true }] }
    }
  });
  const f = fixture({ old, persist: async () => Promise.reject(new Error('persist failed for old-secret')) });
  f.snapshot.cfg.sandbox.backendSettings[serializeSandboxBackendRef(oldRef)] = {
    apiKey: ['$', '{secret:sandbox/builtin/old/apiKey}'].join('')
  };
  f.snapshot.auth.namedSecrets = { 'sandbox/builtin/old/apiKey': 'old-secret' };

  const result = await f.service.activateBackend(nextRef);

  expect(result.error).toContain('[redacted]');
  expect(result.error).not.toContain('old-secret');
});

test('concurrent activation requests are serialized', async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRef = { source: 'builtin', kind: 'first' } as const;
  const secondRef = { source: 'builtin', kind: 'second' } as const;
  const first = launcher('first', {
    prepare: async () => {
      order.push('first:start');
      await firstReady;
      order.push('first:end');
    }
  });
  const second = launcher('second', {
    prepare: () => {
      order.push('second');
    }
  });
  const f = fixture();
  f.setLauncher(firstRef, first);
  f.setLauncher(secondRef, second);

  const one = f.service.activateBackend(firstRef);
  await Bun.sleep(10);
  const two = f.service.activateBackend(secondRef);
  await Bun.sleep(10);
  expect(order).toEqual(['first:start']);
  releaseFirst();
  await Promise.all([one, two]);
  expect(order).toEqual(['first:start', 'first:end', 'second']);
});

test('processes already spawned retain their launcher while new processes use the swapped launcher', async () => {
  const owners: string[] = [];
  const process = (owner: string): SandboxProcess => ({
    exited: new Promise<number>(() => {}),
    kill: () => owners.push(`killed:${owner}`)
  });
  const old = launcher('old', {
    spawn: (owner) => {
      owners.push(owner);
      return process(owner);
    }
  });
  const next = launcher('next', {
    spawn: (owner) => {
      owners.push(owner);
      return process(owner);
    }
  });
  const f = fixture({ old, next });

  const oldProcess = sandboxedSpawn(['before'], undefined);
  await f.service.activateBackend(nextRef);
  const newProcess = sandboxedSpawn(['after'], undefined);

  expect(owners).toEqual(['old', 'next']);
  expect(oldProcess).not.toBe(newProcess);
  oldProcess.kill();
  expect(owners).toContain('killed:old');
});

test('cleanup failure is reported as a warning without rolling back the new backend', async () => {
  const old = launcher('old', { disposeIdle: () => Promise.reject(new Error('cleanup failed')) });
  const f = fixture({ old });
  const result = await f.service.activateBackend(nextRef);

  expect(result).toMatchObject({ status: 'active', cleanupWarning: 'cleanup failed' });
  expect(sandboxLauncher()).toBe(f.next);
});

test('active contributed packs switch to built-in auto before disable or removal', async () => {
  const f = fixture();
  f.snapshot.cfg.sandbox.activeBackend = nextRef;
  configureSandboxLauncher(f.next);

  await f.service.ensurePackCanDeactivate('vendor');

  expect(f.snapshot.cfg.sandbox.activeBackend as SandboxBackendRef).toEqual(autoRef);
  expect(sandboxLauncher()).toBe(f.auto);
});

test('active pack mutation is refused when the built-in auto fallback cannot activate', async () => {
  const f = fixture();
  f.snapshot.cfg.sandbox.activeBackend = nextRef;
  configureSandboxLauncher(f.next);
  f.setLauncher(autoRef, noneLauncher);

  await expect(f.service.ensurePackCanDeactivate('vendor')).rejects.toThrow();
  expect(f.snapshot.cfg.sandbox.activeBackend).toEqual(nextRef);
  expect(sandboxLauncher()).toBe(f.next);
});

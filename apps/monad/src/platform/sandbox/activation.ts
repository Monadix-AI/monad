import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { SandboxBackendRef, SetSandboxSettingsRequest } from '@monad/protocol';
import type { SandboxLauncher, SandboxLauncherDescriptor } from '@monad/sdk-atom';
import type { ConfigAccess } from '#/config/manager.ts';

import { emptyAuth } from '@monad/environment';
import { configureSandboxLauncher, noneLauncher, resolveSandboxLauncher, sandboxLauncher } from '@monad/sandbox';

import { resolveSecretRef } from '#/config/secrets.ts';
import { applyBackendSettingsUpdate, serializeSandboxBackendRef } from '#/platform/sandbox/backend-settings.ts';

type SubmittedSettings = Omit<NonNullable<SetSandboxSettingsRequest['backendSettings']>, 'ref'>;
type ResolvedLauncherSettings = { values: Record<string, unknown>; secrets: string[] };

export interface SandboxActivationSnapshot {
  cfg: MonadConfig;
  auth: MonadAuth;
}

interface SandboxActivationResult {
  requested: SandboxBackendRef;
  effective: SandboxBackendRef;
  status: 'active' | 'error';
  error?: string;
  cleanupWarning?: string;
}

export interface SandboxActivationOptions {
  platform?: NodeJS.Platform;
  load(): Promise<SandboxActivationSnapshot>;
  persist(next: SandboxActivationSnapshot, previous: SandboxActivationSnapshot): Promise<void>;
  resolveLauncher?: (ref: SandboxBackendRef, platform: NodeJS.Platform) => SandboxLauncher | undefined;
  currentLauncher?: () => SandboxLauncher;
  swapLauncher?: (launcher: SandboxLauncher) => void;
}

export interface SandboxActivationService {
  activateBackend(ref: SandboxBackendRef, settings?: SubmittedSettings): Promise<SandboxActivationResult>;
  ensurePackCanDeactivate(packId: string): Promise<void>;
}

function legacyBackend(ref: SandboxBackendRef): MonadConfig['sandbox']['backend'] {
  if (ref.source === 'builtin' && (ref.kind === 'auto' || ref.kind === 'vm')) return ref.kind;
  if (ref.source === 'atom-pack' && (ref.kind === 'docker' || ref.kind === 'e2b')) return ref.kind;
  return 'auto';
}

function errorText(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

function resolvedLauncherSettings(
  descriptor: SandboxLauncherDescriptor,
  stored: Record<string, unknown>,
  auth: MonadAuth
): ResolvedLauncherSettings {
  const values: Record<string, unknown> = {};
  const secrets: string[] = [];
  for (const field of descriptor.settings?.fields ?? []) {
    const storedValue = stored[field.id];
    if (field.type === 'secret') {
      if (typeof storedValue !== 'string') {
        if (field.required) throw new Error(`sandbox backend setting "${field.id}" is required`);
        continue;
      }
      const value = resolveSecretRef(storedValue, auth);
      values[field.id] = value;
      secrets.push(value);
      continue;
    }
    const value = storedValue ?? field.defaultValue;
    if (value === undefined) {
      if (field.required) throw new Error(`sandbox backend setting "${field.id}" is required`);
      continue;
    }
    values[field.id] = value;
  }
  return { values, secrets };
}

function submittedSecretValues(submitted?: SubmittedSettings): string[] {
  return Object.values(submitted?.secrets ?? {}).flatMap((update) =>
    update.action === 'replace' ? [update.value] : []
  );
}

async function prepareResolvedSandboxCandidate(
  ref: SandboxBackendRef,
  candidate: SandboxLauncher,
  resolved: ResolvedLauncherSettings
): Promise<void> {
  const key = serializeSandboxBackendRef(ref);
  if (candidate === noneLauncher || candidate.kind === 'none') {
    throw new Error(`sandbox backend "${key}" provides no confinement`);
  }
  try {
    await candidate.configure?.(resolved.values);
    await candidate.prepare?.();
    if (candidate.isAvailable?.() === false) {
      throw new Error(`sandbox backend "${key}" is unavailable after preparation`);
    }
  } catch (error) {
    throw new Error(errorText(error, resolved.secrets));
  }
}

export async function prepareSandboxCandidate(
  ref: SandboxBackendRef,
  candidate: SandboxLauncher,
  snapshot: SandboxActivationSnapshot
): Promise<void> {
  const key = serializeSandboxBackendRef(ref);
  const resolved = resolvedLauncherSettings(
    candidate.descriptor,
    snapshot.cfg.sandbox.backendSettings[key] ?? {},
    snapshot.auth
  );
  await prepareResolvedSandboxCandidate(ref, candidate, resolved);
}

export function createSandboxActivationService(options: SandboxActivationOptions): SandboxActivationService {
  const platform = options.platform ?? process.platform;
  const resolveLauncher = options.resolveLauncher ?? resolveSandboxLauncher;
  const currentLauncher = options.currentLauncher ?? sandboxLauncher;
  const swapLauncher = options.swapLauncher ?? configureSandboxLauncher;
  let tail: Promise<void> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function activateNow(ref: SandboxBackendRef, submitted?: SubmittedSettings): Promise<SandboxActivationResult> {
    const previous = await options.load();
    const previousRef = previous.cfg.sandbox.activeBackend;
    const previousLauncher = currentLauncher();
    const next = structuredClone(previous);
    let candidate: SandboxLauncher | undefined;
    let candidateSettings: ResolvedLauncherSettings | undefined;
    let previousSettings: ResolvedLauncherSettings | undefined;
    const submittedSecrets = submittedSecretValues(submitted);

    function activationSecrets(): string[] {
      return [...submittedSecrets, ...(candidateSettings?.secrets ?? []), ...(previousSettings?.secrets ?? [])];
    }

    async function restoreActiveLauncherSettings(): Promise<string | undefined> {
      if (!candidate || candidate !== previousLauncher || !previousSettings) return undefined;
      try {
        await previousLauncher.configure?.(previousSettings.values);
        return undefined;
      } catch (error) {
        return errorText(error, activationSecrets());
      }
    }

    try {
      candidate = resolveLauncher(ref, platform);
      if (!candidate) throw new Error(`sandbox backend "${serializeSandboxBackendRef(ref)}" is not registered`);
      const previousKey = serializeSandboxBackendRef(previousRef);
      try {
        previousSettings = resolvedLauncherSettings(
          previousLauncher.descriptor,
          previous.cfg.sandbox.backendSettings[previousKey] ?? {},
          previous.auth
        );
      } catch (error) {
        if (candidate === previousLauncher) throw error;
      }

      if (submitted) {
        const applied = applyBackendSettingsUpdate(next.cfg.sandbox.backendSettings, next.auth, candidate.descriptor, {
          ref,
          ...submitted
        });
        next.cfg.sandbox.backendSettings = applied.backendSettings;
        next.auth = applied.auth;
      }
      const key = serializeSandboxBackendRef(ref);
      candidateSettings = resolvedLauncherSettings(
        candidate.descriptor,
        next.cfg.sandbox.backendSettings[key] ?? {},
        next.auth
      );
      await prepareResolvedSandboxCandidate(ref, candidate, candidateSettings);
    } catch (error) {
      const restoreError = await restoreActiveLauncherSettings();
      const message = errorText(error, activationSecrets());
      return {
        requested: ref,
        effective: previousRef,
        status: 'error',
        error: restoreError ? `${message}; failed to restore previous launcher settings: ${restoreError}` : message
      };
    }

    swapLauncher(candidate);
    next.cfg.sandbox.activeBackend = structuredClone(ref);
    next.cfg.sandbox.backend = legacyBackend(ref);
    try {
      await options.persist(next, previous);
    } catch (error) {
      swapLauncher(previousLauncher);
      const restoreError = await restoreActiveLauncherSettings();
      const message = errorText(error, activationSecrets());
      return {
        requested: ref,
        effective: previousRef,
        status: 'error',
        error: restoreError ? `${message}; failed to restore previous launcher settings: ${restoreError}` : message
      };
    }

    let cleanupWarning: string | undefined;
    if (previousLauncher !== candidate) {
      try {
        await previousLauncher.disposeIdle?.();
      } catch (error) {
        cleanupWarning = errorText(error);
        const retry = setTimeout(() => void Promise.resolve(previousLauncher.disposeIdle?.()).catch(() => {}), 1_000);
        retry.unref?.();
      }
    }
    return {
      requested: ref,
      effective: ref,
      status: 'active',
      ...(cleanupWarning ? { cleanupWarning } : {})
    };
  }

  return {
    activateBackend: (ref, settings) => serialized(() => activateNow(ref, settings)),
    ensurePackCanDeactivate: (packId) =>
      serialized(async () => {
        const snapshot = await options.load();
        const active = snapshot.cfg.sandbox.activeBackend;
        if (active.source !== 'atom-pack' || active.packId !== packId) return;
        const result = await activateNow({ source: 'builtin', kind: 'auto' });
        if (result.status === 'error') {
          throw new Error(`cannot deactivate active sandbox pack "${packId}": ${result.error}`);
        }
      })
  };
}

export function createConfigSandboxActivationService(config: ConfigAccess): SandboxActivationService {
  return createSandboxActivationService({
    load: async () => {
      const snapshot = structuredClone(config.get());
      return { cfg: snapshot.cfg, auth: snapshot.auth ?? emptyAuth() };
    },
    persist: async (next) => {
      await config.update((draft) => {
        draft.cfg = next.cfg;
        draft.auth = next.auth;
      });
    }
  });
}

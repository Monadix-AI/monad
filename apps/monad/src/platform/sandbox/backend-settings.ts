import type { MonadAuth } from '@monad/environment';
import type { InteractionField, SandboxBackendRef, SetSandboxSettingsRequest } from '@monad/protocol';
import type { SandboxLauncherDescriptor } from '@monad/sdk-atom';

import { sandboxBackendRefSchema } from '@monad/protocol';

type BackendSettingsUpdate = NonNullable<SetSandboxSettingsRequest['backendSettings']>;

export function serializeSandboxBackendRef(ref: SandboxBackendRef): string {
  const parsed = sandboxBackendRefSchema.parse(ref);
  const segment = (value: string) => encodeURIComponent(value);
  return parsed.source === 'builtin'
    ? `builtin/${segment(parsed.kind)}`
    : `atom-pack/${segment(parsed.packId)}/${segment(parsed.kind)}`;
}

function sandboxBackendSecretName(ref: SandboxBackendRef, fieldId: string): string {
  return `sandbox/${serializeSandboxBackendRef(ref)}/${encodeURIComponent(fieldId)}`;
}

function invalid(fieldId: string, detail: string): never {
  throw new Error(`invalid sandbox backend setting "${fieldId}": ${detail}`);
}

function validateValue(field: InteractionField, value: unknown): void {
  switch (field.type) {
    case 'secret':
      throw new Error(
        `invalid sandbox backend setting "${field.id}": secret fields must use an explicit replace or remove action`
      );
    case 'string': {
      if (typeof value !== 'string') invalid(field.id, 'expected a string');
      if (field.pattern) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(field.pattern);
        } catch {
          invalid(field.id, 'the contributed pattern is invalid');
        }
        if (!pattern.test(value)) invalid(field.id, `value does not match ${field.pattern}`);
      }
      return;
    }
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field.id, 'expected a finite number');
      if (field.min !== undefined && value < field.min) invalid(field.id, `must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) invalid(field.id, `must be at most ${field.max}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') invalid(field.id, 'expected a boolean');
      return;
    case 'select':
      if (typeof value !== 'string' || !field.options.some((option) => option.value === value)) {
        invalid(field.id, 'must be one of the declared options');
      }
  }
}

export interface AppliedBackendSettings {
  backendSettings: Record<string, Record<string, unknown>>;
  auth: MonadAuth;
  authChanged: boolean;
}

export function applyBackendSettingsUpdate(
  current: Record<string, Record<string, unknown>>,
  auth: MonadAuth,
  descriptor: SandboxLauncherDescriptor,
  update: BackendSettingsUpdate
): AppliedBackendSettings {
  const key = serializeSandboxBackendRef(update.ref);
  const fields = new Map((descriptor.settings?.fields ?? []).map((field) => [field.id, field]));
  const backendSettings = structuredClone(current);
  const values = { ...(backendSettings[key] ?? {}) };
  const nextAuth = structuredClone(auth);
  nextAuth.namedSecrets = { ...(nextAuth.namedSecrets ?? {}) };
  let authChanged = false;

  for (const [fieldId, value] of Object.entries(update.values ?? {})) {
    const field = fields.get(fieldId);
    if (!field) invalid(fieldId, 'field is not declared by this backend');
    validateValue(field, value);
    values[fieldId] = value;
  }

  for (const [fieldId, operation] of Object.entries(update.secrets ?? {})) {
    const field = fields.get(fieldId);
    if (!field) invalid(fieldId, 'field is not declared by this backend');
    if (field.type !== 'secret') invalid(fieldId, 'field is not a secret');
    const name = sandboxBackendSecretName(update.ref, fieldId);
    if (operation.action === 'replace') {
      if (!operation.value) invalid(fieldId, 'secret replacement must not be empty');
      nextAuth.namedSecrets[name] = operation.value;
      values[fieldId] = `\${secret:${name}}`;
    } else {
      delete nextAuth.namedSecrets[name];
      delete values[fieldId];
    }
    authChanged = true;
  }

  backendSettings[key] = values;
  if (authChanged) nextAuth.updatedAt = new Date().toISOString();
  return { backendSettings, auth: nextAuth, authChanged };
}

function configuredSecret(value: unknown, auth: MonadAuth): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(/^\$\{secret:(sandbox\/.+)}$/);
  return match ? Boolean(auth.namedSecrets?.[match[1] as string]) : false;
}

export function redactBackendSettings(
  settings: Record<string, Record<string, unknown>>,
  auth: MonadAuth,
  descriptors: ReadonlyMap<string, SandboxLauncherDescriptor>
): Record<string, Record<string, unknown>> {
  const redacted: Record<string, Record<string, unknown>> = {};
  for (const [key, stored] of Object.entries(settings)) {
    const view: Record<string, unknown> = {};
    for (const [fieldId, value] of Object.entries(stored)) {
      view[fieldId] =
        typeof value === 'string' && value.startsWith('${secret:sandbox/')
          ? { configured: configuredSecret(value, auth) }
          : structuredClone(value);
    }
    for (const field of descriptors.get(key)?.settings?.fields ?? []) {
      if (field.type === 'secret') view[field.id] = { configured: configuredSecret(stored[field.id], auth) };
    }
    redacted[key] = view;
  }
  return redacted;
}

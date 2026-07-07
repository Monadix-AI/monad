import type { ExternalAgentSettingsImportItem } from '@monad/protocol';

import { createHash } from 'node:crypto';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publicItemWithoutHash(
  item: ExternalAgentSettingsImportItem
): Omit<ExternalAgentSettingsImportItem, 'hash'> {
  const { hash: _hash, ...rest } = item;
  return rest;
}

export function externalAgentSettingsImportItemHash(item: Omit<ExternalAgentSettingsImportItem, 'hash'>): string {
  return sha256(stableJson(item));
}

export function withHash(item: Omit<ExternalAgentSettingsImportItem, 'hash'>): ExternalAgentSettingsImportItem {
  return { ...item, hash: externalAgentSettingsImportItemHash(item) };
}

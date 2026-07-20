import type { MeshAgentAuthState } from '@monad/protocol';

/** Parse one JSON object literal; `undefined` for non-objects, arrays, or parse errors. */
export function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = z.json().parse(JSON.parse(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Drop `undefined`-valued keys so a serialized event payload carries only present fields. */
export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Concatenate the `text` fields of an Anthropic-style content-block array into one string. */
export function textFromContentParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    )
    .join('');
}

/** True when argv contains `flag` or a `flag=value` form. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/** De-duplicate and trim a list of model/effort names, dropping blanks. */
export function uniqueModelNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/** Read a structured auth-state line (`{ state | authenticated | loggedIn }`) from a provider's `--json` output. */
export function parseStructuredAuthState(output: string): MeshAgentAuthState | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const record = parseJsonObject(rawLine.trim());
    if (!record) continue;
    if (record.state === 'authenticated' || record.authenticated === true || record.loggedIn === true)
      return 'authenticated';
    if (record.state === 'unauthenticated' || record.authenticated === false || record.loggedIn === false)
      return 'unauthenticated';
    if (record.state === 'unknown') return 'unknown';
  }
  return undefined;
}

import { z } from 'zod';

import type { ImportSettingsCategory, ImportSettingsRisk } from '@monad/protocol';
import type { PlannedItem } from '../types.ts';

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

export function asRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value) && value.every(isRecord) ? value : undefined;
}

export function getPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const part of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function _recordAt(root: unknown, path: string[]): Record<string, unknown> | undefined {
  const value = getPath(root, path);
  return isRecord(value) ? value : undefined;
}

function parseJsonOrYaml(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return Bun.YAML.parse(text);
  }
}

function expandPath(inputPath: string): string {
  let out = inputPath;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(2));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => process.env[name] ?? match);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    const name = (braced ?? bare) as string;
    return process.env[name] ?? match;
  });
  return out;
}

export async function pathInfo(inputPath: string): Promise<{ root: string; isDir: boolean }> {
  const expanded = expandPath(inputPath);
  const candidates = new Map<string, string>();
  candidates.set(expanded, resolve(expanded));
  const forward = expanded.replace(/\\/g, '/');
  if (forward !== expanded) candidates.set(forward, resolve(forward));
  const backward = expanded.replace(/\//g, '\\');
  if (backward !== expanded) candidates.set(backward, resolve(backward));

  let lastError: unknown;
  for (const root of candidates.values()) {
    try {
      const s = await stat(root);
      return { root, isDir: s.isDirectory() };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function readConfigObject(
  root: string,
  isDir: boolean,
  names: string[]
): Promise<{ path: string; data: unknown } | null> {
  const candidates = isDir ? names.map((name) => join(root, ...name.split(/[\\/]+/).filter(Boolean))) : [root];
  for (const path of candidates) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_CONFIG_BYTES) {
      throw new Error(`config file "${path}" is too large (${info.size} bytes; max ${MAX_CONFIG_BYTES})`);
    }
    const file = Bun.file(path);
    const text = await file.text();
    return { path, data: extname(path) === '.toml' ? Bun.TOML.parse(text) : parseJsonOrYaml(text) };
  }
  return null;
}

export async function readFirstConfigObject(
  root: string,
  isDir: boolean,
  namesByDir: string[][]
): Promise<{ path: string; data: unknown } | null> {
  for (const names of namesByDir) {
    const cfg = await readConfigObject(root, isDir, names);
    if (cfg) return cfg;
  }
  return null;
}

function itemId(category: ImportSettingsCategory, target: string): string {
  return `${category}:${target}`.replace(/[^A-Za-z0-9:_./-]+/g, '-');
}

export function addItem(
  items: PlannedItem[],
  input: Omit<PlannedItem, 'id' | 'risk'> & { risk?: ImportSettingsRisk }
): void {
  items.push({ id: itemId(input.category, input.target), risk: input.risk ?? 'low', ...input });
}

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

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

export function recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

export function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported';
}

export async function pathInfo(inputPath: string): Promise<{ root: string; isDir: boolean }> {
  const root = resolve(inputPath.startsWith('~/') ? join(homedir(), inputPath.slice(2)) : inputPath);
  const info = await stat(root);
  return { root, isDir: info.isDirectory() };
}

export async function readConfigObject(
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
    const text = await Bun.file(path).text();
    if (extname(path) === '.toml') return { path, data: Bun.TOML.parse(text) };
    if (extname(path) === '.yaml' || extname(path) === '.yml') return { path, data: Bun.YAML.parse(text) };
    return { path, data: JSON.parse(text) };
  }
  return null;
}

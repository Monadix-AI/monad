import { join, relative } from 'node:path';
import { Glob } from 'bun';

import { EN_DIR, IGNORED_PARTS, type Namespace, ROOT, SOURCE_EXTENSIONS, ZH_DIR } from './constants';

function extensionOf(path: string): string {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0] ?? '';
}

function isIgnored(path: string): boolean {
  if (path.startsWith('packages/i18n/src/locales/')) return true;
  return path.split('/').some((part) => IGNORED_PARTS.has(part));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usagePattern(key: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(key)}([^A-Za-z0-9_.-]|$)`);
}

function baseKey(key: string): string {
  return key.replace(/_(zero|one|two|few|many|other)$/, '');
}

async function loadNamespaces(dir: string): Promise<Namespace[]> {
  const glob = new Glob('*.json');
  const namespaces: Namespace[] = [];
  for await (const file of glob.scan({ cwd: dir })) {
    namespaces.push({
      file,
      messages: (await Bun.file(join(dir, file)).json()) as Record<string, string>
    });
  }
  return namespaces.sort((a, b) => a.file.localeCompare(b.file));
}

async function collectProjectText(): Promise<string> {
  const glob = new Glob('**/*');
  const chunks: string[] = [];
  for await (const path of glob.scan({ cwd: ROOT, dot: true, onlyFiles: true })) {
    if (isIgnored(path) || !SOURCE_EXTENSIONS.has(extensionOf(path))) continue;
    try {
      chunks.push(await Bun.file(join(ROOT, path)).text());
    } catch {
      // Binary or transient files are not useful for static key detection.
    }
  }
  return chunks.join('\n');
}

async function writeJson(path: string, messages: Record<string, string>, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await Bun.write(path, `${JSON.stringify(messages, null, 2)}\n`);
}

function dynamicPrefixes(projectText: string): string[] {
  const prefixes = new Set<string>();
  const pattern = /\bt\(\s*`([^`]*?)\$\{/g;
  for (const match of projectText.matchAll(pattern)) {
    const prefix = match[1];
    if (prefix) prefixes.add(prefix);
  }
  return [...prefixes];
}

function isUsed(key: string, projectText: string, prefixes: string[]): boolean {
  if (usagePattern(key).test(projectText) || usagePattern(baseKey(key)).test(projectText)) return true;
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function pruneUnusedEnglish(namespaces: Namespace[], projectText: string): string[] {
  const prefixes = dynamicPrefixes(projectText);
  const removed: string[] = [];
  for (const namespace of namespaces) {
    for (const key of Object.keys(namespace.messages)) {
      if (isUsed(key, projectText, prefixes)) continue;
      delete namespace.messages[key];
      removed.push(`${namespace.file}:${key}`);
    }
  }
  return removed;
}

function pruneZhExtras(namespaces: Namespace[], enKeys: Set<string>): string[] {
  const removed: string[] = [];
  for (const namespace of namespaces) {
    for (const key of Object.keys(namespace.messages)) {
      if (enKeys.has(key)) continue;
      delete namespace.messages[key];
      removed.push(`${namespace.file}:${key}`);
    }
  }
  return removed;
}

function keySet(namespaces: Namespace[]): Set<string> {
  const keys = new Set<string>();
  for (const namespace of namespaces) {
    for (const key of Object.keys(namespace.messages)) keys.add(key);
  }
  return keys;
}

export async function pruneI18n(dryRun: boolean): Promise<void> {
  const [enNamespaces, zhNamespaces, projectText] = await Promise.all([
    loadNamespaces(EN_DIR),
    loadNamespaces(ZH_DIR),
    collectProjectText()
  ]);

  const removedEn = pruneUnusedEnglish(enNamespaces, projectText);
  const removedZh = pruneZhExtras(zhNamespaces, keySet(enNamespaces));

  await Promise.all([
    ...enNamespaces.map((namespace) => writeJson(join(EN_DIR, namespace.file), namespace.messages, dryRun)),
    ...zhNamespaces.map((namespace) => writeJson(join(ZH_DIR, namespace.file), namespace.messages, dryRun))
  ]);

  const mode = dryRun ? 'dry-run' : 'write';
  process.stdout.write(`i18n prune: ${mode}\n`);
  process.stdout.write(`removed unused en keys: ${removedEn.length}\n`);
  for (const key of removedEn) process.stdout.write(`  - en/${key}\n`);
  process.stdout.write(`removed zh keys missing from en: ${removedZh.length}\n`);
  for (const key of removedZh) process.stdout.write(`  - zh/${key}\n`);
  process.stdout.write(`locales: ${relative(ROOT, join(EN_DIR, '..'))}\n`);
}

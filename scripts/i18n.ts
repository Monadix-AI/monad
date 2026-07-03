/// <reference types="bun" />
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Glob } from 'bun';

const ROOT = join(import.meta.dir, '..');
const LOCALES_DIR = join(import.meta.dir, '..', 'packages', 'i18n', 'src', 'locales');
const EN_DIR = join(LOCALES_DIR, 'en');
const ZH_DIR = join(LOCALES_DIR, 'zh');
const I18N_SRC_DIR = join(import.meta.dir, '..', 'packages', 'i18n', 'src');
const GENERATED_PATH = join(I18N_SRC_DIR, 'catalog-types.ts');
const PARAGLIDE_INPUT_DIR = join(I18N_SRC_DIR, 'paraglide-input');
const PARAGLIDE_OUTPUT_DIR = join(I18N_SRC_DIR, 'paraglide');
const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const PARAM_RE = /{{\s*([A-Za-z_$][\w$]*)\s*}}/g;
const PARAGLIDE_SCOPES = {
  common: ['channel', 'cmd', 'daemon', 'init'],
  cli: ['cli'],
  web: ['web']
} as const;
const PARAGLIDE_SCOPE_NAMES = Object.keys(PARAGLIDE_SCOPES).sort() as ParaglideScope[];
const SHARED_RUNTIME_SCOPE = 'common' satisfies ParaglideScope;
const PRUNED_PARAGLIDE_FILES = ['registry.d.ts', 'registry.js', 'server.d.ts', 'server.js'];
const SOURCE_EXTENSIONS = new Set([
  '.css',
  '.cts',
  '.cjs',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.ps1',
  '.scss',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml'
]);
const IGNORED_PARTS = new Set([
  '.codegraph',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
]);

type Catalog = Record<string, string>;
type ParaglideScope = keyof typeof PARAGLIDE_SCOPES;

interface LocaleCatalog {
  locale: string;
  messages: Catalog;
  namespaces: Record<string, Catalog>;
}

interface Diagnostic {
  locale: string;
  message: string;
}

interface Namespace {
  file: string;
  messages: Record<string, string>;
}

type Mode = 'check' | 'write' | 'write-if-stale' | 'watch' | 'prune' | 'prune-dry-run';

function usage(): never {
  throw new Error('usage: bun run scripts/i18n.ts [--check|--write|--write-if-stale|--watch|prune [--dry-run]]');
}

function parseMode(): Mode {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) return 'check';
  if (args.length === 1 && args[0] === '--write') return 'write';
  if (args.length === 1 && args[0] === '--write-if-stale') return 'write-if-stale';
  if (args.length === 1 && args[0] === '--watch') return 'watch';
  if (args.length === 1 && args[0] === 'prune') return 'prune';
  if (args.length === 2 && args[0] === 'prune' && args[1] === '--dry-run') return 'prune-dry-run';
  return usage();
}

async function loadJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch (err) {
    throw new Error(`${relative(process.cwd(), path)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadLocales(): Promise<LocaleCatalog[]> {
  const localeEntries = await readdir(LOCALES_DIR, { withFileTypes: true });
  const locales: LocaleCatalog[] = [];

  for (const entry of localeEntries) {
    if (!entry.isDirectory()) continue;
    const locale = entry.name;
    const localeDir = join(LOCALES_DIR, locale);
    const files = (await readdir(localeDir, { withFileTypes: true }))
      .filter((file) => file.isFile() && file.name.endsWith('.json'))
      .map((file) => file.name)
      .sort();
    const messages: Catalog = {};
    const namespaces: Record<string, Catalog> = {};

    for (const file of files) {
      const path = join(localeDir, file);
      const namespace = file.replace(/\.json$/, '');
      const json = await loadJson(path);
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error(`${relative(process.cwd(), path)}: expected a flat JSON object`);
      }
      const namespaceMessages: Catalog = {};
      for (const [key, value] of Object.entries(json)) {
        if (typeof value !== 'string') {
          throw new Error(`${relative(process.cwd(), path)}: ${key} must be a string`);
        }
        namespaceMessages[key] = value;
        messages[key] = value;
      }
      namespaces[namespace] = namespaceMessages;
    }

    locales.push({ locale, messages, namespaces });
  }

  return locales.sort((a, b) => a.locale.localeCompare(b.locale));
}

function pluralSuffix(key: string): string | undefined {
  const suffix = key.slice(key.lastIndexOf('_') + 1);
  return PLURAL_SUFFIXES.has(suffix) ? suffix : undefined;
}

function pluralBaseKey(key: string): string {
  const suffix = pluralSuffix(key);
  return suffix ? key.slice(0, -(suffix.length + 1)) : key;
}

function pluralCategories(locale: string): Set<string> {
  return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
}

/** A plural set (`x_one`/`x_other`) is also addressable by its base key `x` with `{count}` — the
 *  runtime appends the CLDR category at call time (see runtime.ts pluralKey). `t()` callers use the
 *  base key; the literal suffixed keys stay valid too (e.g. a <Trans> component needs a literal id).
 *  So the generated id set must include both. */
function withPluralBaseKeys(keys: string[]): string[] {
  const out = new Set(keys);
  for (const key of keys) if (pluralSuffix(key)) out.add(pluralBaseKey(key));
  return [...out].sort();
}

function paramsOf(message: string): string[] {
  const params = new Set<string>();
  for (const match of message.matchAll(PARAM_RE)) params.add(match[1] as string);
  return [...params].sort();
}

function toParaglidePattern(message: string): string {
  return message.replaceAll(/{{\s*([A-Za-z_$][\w$]*)\s*}}/g, '{$1}');
}

function paraglideScopeForNamespace(namespace: string): ParaglideScope {
  if (namespace === 'cli') return 'cli';
  if (namespace === 'web') return 'web';
  return 'common';
}

export function changedParaglideScopes(paths: string[]): ParaglideScope[] {
  const scopes = new Set<ParaglideScope>();
  for (const path of paths) {
    const parts = path.split(/[\\/]/);
    const localesIndex = parts.lastIndexOf('locales');
    const filename = localesIndex === -1 ? undefined : parts[localesIndex + 2];
    if (!filename?.endsWith('.json')) continue;
    scopes.add(paraglideScopeForNamespace(filename.replace(/\.json$/, '')));
  }
  return [...scopes].sort();
}

function validateCatalogs(locales: LocaleCatalog[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const en = locales.find((locale) => locale.locale === 'en');
  if (!en) return [{ locale: 'en', message: 'canonical English locale is missing' }];

  const enKeys = Object.keys(en.messages).sort();
  const enKeySet = new Set(enKeys);
  const enParams = new Map(enKeys.map((key) => [key, paramsOf(en.messages[key] ?? '')]));

  for (const locale of locales) {
    const localeKeys = Object.keys(locale.messages).sort();
    const localeKeySet = new Set(localeKeys);
    const categories = pluralCategories(locale.locale);

    for (const key of localeKeys) {
      if (!enKeySet.has(key)) diagnostics.push({ locale: locale.locale, message: `${key} does not exist in en` });
    }

    for (const key of enKeys) {
      const suffix = pluralSuffix(key);
      if (!localeKeySet.has(key) && (!suffix || categories.has(suffix))) {
        diagnostics.push({ locale: locale.locale, message: `${key} is missing` });
        continue;
      }
      if (!localeKeySet.has(key)) continue;
      const actual = paramsOf(locale.messages[key] ?? '');
      const expected = enParams.get(key) ?? [];
      if (actual.join('\0') !== expected.join('\0')) {
        diagnostics.push({
          locale: locale.locale,
          message: `${key} params ${JSON.stringify(actual)} do not match en ${JSON.stringify(expected)}`
        });
      }
    }
  }

  return diagnostics;
}

function stringLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function typeNameForNamespace(namespace: string): string {
  const words = namespace.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `${words.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join('')}MessageId`;
}

function renderIdUnion(keys: string[]): string {
  return keys.map((key) => `  | ${stringLiteral(key)}`).join('\n');
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : stringLiteral(value);
}

function renderGenerated(en: LocaleCatalog): string {
  const keys = Object.keys(en.messages).sort();
  const namespaces = Object.keys(en.namespaces).sort();
  const paramsByKey = new Map<string, string[]>();
  const paramsByPluralBase = new Map<string, Set<string>>();
  for (const key of keys) {
    const params = paramsOf(en.messages[key] ?? '');
    const suffix = pluralSuffix(key);
    if (suffix) params.push('count');
    paramsByKey.set(key, params);

    const baseKey = pluralBaseKey(key);
    const baseParams = paramsByPluralBase.get(baseKey) ?? new Set<string>();
    for (const param of params) baseParams.add(param);
    paramsByPluralBase.set(baseKey, baseParams);
  }
  for (const key of keys) {
    const pluralParams = paramsByPluralBase.get(pluralBaseKey(key));
    if (!pluralParams) continue;
    paramsByKey.set(key, [...new Set([...(paramsByKey.get(key) ?? []), ...pluralParams])].sort());
  }
  // Expose each plural set's base key (e.g. `web.chat.queued`) as a callable id carrying its
  // accumulated params, so `t(base, { count })` type-checks (runtime resolves the suffix).
  for (const [baseKey, baseParams] of paramsByPluralBase) {
    if (!paramsByKey.has(baseKey)) paramsByKey.set(baseKey, [...baseParams].sort());
  }
  const allKeys = withPluralBaseKeys(keys);
  const idUnion = renderIdUnion(allKeys);
  const paramsEntries = allKeys
    .map((key) => {
      const params = paramsByKey.get(key) ?? [];
      const value =
        params.length === 0
          ? 'undefined'
          : `{ ${params.map((param) => `${param}: ${param === 'count' ? 'number' : 'string | number'}`).join('; ')} }`;
      return `  ${stringLiteral(key)}: ${value};`;
    })
    .join('\n');
  const namespaceTypes = namespaces
    .map((namespace) => {
      const typeName = typeNameForNamespace(namespace);
      const namespaceKeys = withPluralBaseKeys(Object.keys(en.namespaces[namespace] ?? {}));
      return `export type ${typeName} =\n${renderIdUnion(namespaceKeys)};`;
    })
    .join('\n\n');
  const namespaceParamTypes = namespaces
    .map((namespace) => {
      const typeName = typeNameForNamespace(namespace);
      return `export type ${typeName}WithParams = BuiltinMessageIdWithParamsForNamespace<${stringLiteral(namespace)}>;\nexport type ${typeName}WithoutParams = BuiltinMessageIdWithoutParamsForNamespace<${stringLiteral(namespace)}>;`;
    })
    .join('\n\n');
  const namespaceUnion = namespaces.map(stringLiteral).join(' | ');
  const namespaceMap = namespaces
    .map((namespace) => `  ${propertyName(namespace)}: ${typeNameForNamespace(namespace)};`)
    .join('\n');

  return `// Generated by scripts/i18n.ts. Do not edit by hand.\n\nexport type BuiltinMessageId =\n${idUnion};\n\n${namespaceTypes}\n\nexport type BuiltinMessageNamespace = ${namespaceUnion};\n\nexport interface BuiltinMessageIdsByNamespace {\n${namespaceMap}\n}\n\nexport type BuiltinMessageIdForNamespace<N extends BuiltinMessageNamespace> = BuiltinMessageIdsByNamespace[N];\n\ninterface BuiltinMessageParams {\n${paramsEntries}\n}\n\nexport type BuiltinMessageParamsFor<K extends BuiltinMessageId> = BuiltinMessageParams[K];\ntype BuiltinMessageIdsWithParams = {\n  [K in BuiltinMessageId]: BuiltinMessageParams[K] extends undefined ? never : K;\n}[BuiltinMessageId];\ntype BuiltinMessageIdsWithoutParams = Exclude<BuiltinMessageId, BuiltinMessageIdsWithParams>;\nexport type BuiltinMessageIdWithParamsForNamespace<N extends BuiltinMessageNamespace> = Extract<\n  BuiltinMessageIdsWithParams,\n  BuiltinMessageIdForNamespace<N>\n>;\nexport type BuiltinMessageIdWithoutParamsForNamespace<N extends BuiltinMessageNamespace> = Extract<\n  BuiltinMessageIdsWithoutParams,\n  BuiltinMessageIdForNamespace<N>\n>;\n\n${namespaceParamTypes}\n\nexport interface StrictTranslate {\n  <K extends BuiltinMessageIdsWithParams>(key: K, params: BuiltinMessageParams[K]): string;\n  <K extends BuiltinMessageIdsWithoutParams>(key: K, params?: undefined): string;\n}\n\nexport interface StrictTranslateForNamespace<N extends BuiltinMessageNamespace> {\n  <K extends BuiltinMessageIdWithParamsForNamespace<N>>(key: K, params: BuiltinMessageParams[K]): string;\n  <K extends BuiltinMessageIdWithoutParamsForNamespace<N>>(key: K, params?: undefined): string;\n}\n`;
}

function messagesForScope(locale: LocaleCatalog, fallback: LocaleCatalog, scope: ParaglideScope): Catalog {
  const messages: Catalog = {};
  const namespaces = Object.keys(fallback.namespaces).sort();
  for (const namespace of namespaces) {
    if (paraglideScopeForNamespace(namespace) !== scope) continue;
    const fallbackMessages = fallback.namespaces[namespace] ?? {};
    const localeMessages = locale.namespaces[namespace] ?? {};
    for (const key of Object.keys(fallbackMessages).sort()) {
      messages[key] = localeMessages[key] ?? fallbackMessages[key] ?? key;
    }
  }
  return messages;
}

function renderParaglideInput(messagesForLocale: Catalog): string {
  const messages: Record<string, string> = { $schema: 'https://inlang.com/schema/inlang-message-format' };
  const keys = Object.keys(messagesForLocale).sort();
  for (const key of keys) {
    messages[key] = toParaglidePattern(messagesForLocale[key] ?? key);
  }
  return `${JSON.stringify(messages, null, 2)}\n`;
}

function renderParaglideInputs(locales: LocaleCatalog[], fallback: LocaleCatalog): Map<string, string> {
  const files = new Map<string, string>();
  for (const locale of locales) {
    for (const scope of PARAGLIDE_SCOPE_NAMES) {
      const messages = messagesForScope(locale, fallback, scope);
      files.set(join(PARAGLIDE_INPUT_DIR, scope, `${locale.locale}.json`), renderParaglideInput(messages));
    }
  }
  return files;
}

async function writeFiles(files: Map<string, string>): Promise<void> {
  for (const [path, contents] of files) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, contents);
  }
}

export function generatedFilesMatch(expected: Map<string, string>, actual: Map<string, string>): boolean {
  if (actual.size !== expected.size) return false;
  for (const [path, contents] of expected) {
    if (actual.get(path) !== contents) return false;
  }
  return true;
}

function renderParaglideSettings(pathPattern: string): string {
  return `${JSON.stringify(
    {
      $schema: 'https://inlang.com/schema/project-settings',
      baseLocale: 'en',
      locales: ['en', 'zh'],
      modules: ['https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4.4.0/dist/index.js'],
      'plugin.inlang.messageFormat': { pathPattern }
    },
    null,
    2
  )}\n`;
}

async function rewriteScopeRuntimeImports(outdir: string): Promise<void> {
  const messagesDir = join(outdir, 'messages');
  const files = await collectFiles(messagesDir).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
    const current = await Bun.file(file).text();
    const next = current
      .replaceAll('"../runtime.js"', '"../../common/runtime.js"')
      .replaceAll("'../runtime.js'", "'../../common/runtime.js'");
    if (next !== current) await Bun.write(file, next);
  }
}

async function pruneParaglideOutput(outdir: string, scope: ParaglideScope): Promise<void> {
  for (const file of PRUNED_PARAGLIDE_FILES) {
    await rm(join(outdir, file), { force: true });
  }
  if (scope === SHARED_RUNTIME_SCOPE) return;
  await rewriteScopeRuntimeImports(outdir);
  await rm(join(outdir, 'runtime.d.ts'), { force: true });
  await rm(join(outdir, 'runtime.js'), { force: true });
}

async function runParaglideCompile(scope: ParaglideScope, outdir = join(PARAGLIDE_OUTPUT_DIR, scope)): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), `monad-paraglide-project-${scope}-`));
  const tmpProjectDir = join(tmp, 'project.inlang');
  try {
    await mkdir(tmpProjectDir, { recursive: true });
    await Bun.write(
      join(tmpProjectDir, 'settings.json'),
      renderParaglideSettings(join(PARAGLIDE_INPUT_DIR, scope, '{locale}.json'))
    );
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });
    const proc = Bun.spawn({
      cmd: [
        'bunx',
        'paraglide-js',
        'compile',
        '--project',
        tmpProjectDir,
        '--outdir',
        outdir,
        '--output-structure',
        'locale-modules',
        '--emit-ts-declarations',
        '--no-emit-git-ignore',
        '--no-emit-prettier-ignore',
        '--no-emit-readme',
        '--silent'
      ],
      cwd: process.cwd(),
      stdout: 'inherit',
      stderr: 'inherit'
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`paraglide-js compile failed with exit code ${exitCode}`);
    await pruneParaglideOutput(outdir, scope);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runParaglideCompiles(scopes: readonly ParaglideScope[] = PARAGLIDE_SCOPE_NAMES): Promise<void> {
  if (scopes.length === PARAGLIDE_SCOPE_NAMES.length) await rm(PARAGLIDE_OUTPUT_DIR, { recursive: true, force: true });
  for (const scope of scopes) await runParaglideCompile(scope);
}

async function readExistingFiles(paths: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    files.set(path, await file.text());
  }
  return files;
}

async function currentGeneratedFiles(generated: string, paraglideInputs: Map<string, string>): Promise<boolean> {
  const expected = new Map([[GENERATED_PATH, generated], ...paraglideInputs]);
  const inputFiles = await collectFiles(PARAGLIDE_INPUT_DIR).catch(() => []);
  const actual = await readExistingFiles([GENERATED_PATH, ...inputFiles]);
  return generatedFilesMatch(expected, actual);
}

async function paraglideOutputsExist(): Promise<boolean> {
  for (const scope of PARAGLIDE_SCOPE_NAMES) {
    const files = await collectFiles(join(PARAGLIDE_OUTPUT_DIR, scope)).catch(() => []);
    if (files.length === 0) return false;
  }
  return true;
}

async function runParaglideCompileInDir(
  scope: ParaglideScope,
  inputDir: string,
  outdir: string,
  cwd: string
): Promise<number> {
  const tmpProjectDir = join(cwd, `${scope}.inlang`);
  await mkdir(tmpProjectDir, { recursive: true });
  await Bun.write(
    join(tmpProjectDir, 'settings.json'),
    renderParaglideSettings(join(inputDir, scope, '{locale}.json'))
  );
  const proc = Bun.spawn({
    cmd: [
      'bunx',
      'paraglide-js',
      'compile',
      '--project',
      tmpProjectDir,
      '--outdir',
      outdir,
      '--output-structure',
      'locale-modules',
      '--emit-ts-declarations',
      '--no-emit-git-ignore',
      '--no-emit-prettier-ignore',
      '--no-emit-readme',
      '--silent'
    ],
    cwd,
    stdout: 'ignore',
    stderr: 'inherit'
  });
  return proc.exited;
}

async function checkParaglideCompiles(inputFiles: Map<string, string>, diagnostics: Diagnostic[]): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'monad-paraglide-'));
  try {
    const tmpInputDir = join(tmp, 'packages', 'i18n', 'src', 'paraglide-input');
    const tmpOutDir = join(tmp, 'paraglide');
    const tmpInputFiles = new Map(
      [...inputFiles].map(([path, contents]) => [join(tmpInputDir, relative(PARAGLIDE_INPUT_DIR, path)), contents])
    );
    await writeFiles(tmpInputFiles);
    for (const scope of PARAGLIDE_SCOPE_NAMES) {
      const outdir = join(tmpOutDir, scope);
      const exitCode = await runParaglideCompileInDir(scope, tmpInputDir, outdir, tmp);
      if (exitCode !== 0) {
        diagnostics.push({ locale: 'types', message: `paraglide-js compile failed with exit code ${exitCode}` });
        return;
      }
      await pruneParaglideOutput(outdir, scope);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function writeCatalog(
  mode: 'write' | 'write-if-stale',
  scopes: readonly ParaglideScope[] = PARAGLIDE_SCOPE_NAMES
) {
  const locales = await loadLocales();
  const diagnostics = validateCatalogs(locales);
  const en = locales.find((locale) => locale.locale === 'en');
  if (!en) throw new Error('canonical English locale is missing');

  const generated = renderGenerated(en);
  const paraglideInputs = renderParaglideInputs(locales, en);

  if (mode === 'write' || mode === 'write-if-stale') {
    if (
      mode === 'write-if-stale' &&
      (await currentGeneratedFiles(generated, paraglideInputs)) &&
      (await paraglideOutputsExist())
    ) {
      process.stdout.write('i18n catalog types up to date\n');
    } else {
      await Bun.write(GENERATED_PATH, generated);
      await rm(PARAGLIDE_INPUT_DIR, { recursive: true, force: true });
      await writeFiles(paraglideInputs);
      await runParaglideCompiles(scopes);
      if (mode === 'write-if-stale') process.stdout.write('i18n catalog types generated\n');
    }
  }

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) process.stderr.write(`[${diagnostic.locale}] ${diagnostic.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (mode === 'write') process.stdout.write('i18n catalog types generated\n');
}

async function checkCatalog() {
  const locales = await loadLocales();
  const diagnostics = validateCatalogs(locales);
  const en = locales.find((locale) => locale.locale === 'en');
  if (!en) throw new Error('canonical English locale is missing');
  const paraglideInputs = renderParaglideInputs(locales, en);

  await checkParaglideCompiles(paraglideInputs, diagnostics);

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) process.stderr.write(`[${diagnostic.locale}] ${diagnostic.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('i18n catalog check passed\n');
}

async function watchCatalog() {
  await writeCatalog('write-if-stale');
  process.stdout.write('i18n catalog watcher ready\n');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Set<string>();
  const schedule = (filename: string | null) => {
    if (filename) changed.add(join(LOCALES_DIR, filename));
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const paths = [...changed];
      changed.clear();
      const scopes = changedParaglideScopes(paths);
      if (scopes.length === 0) return;
      try {
        await writeCatalog('write-if-stale', scopes);
      } catch (err) {
        process.stderr.write(`i18n catalog update failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }, 200);
  };

  const watcher = watch(LOCALES_DIR, { recursive: true }, (_event, filename) => schedule(filename?.toString() ?? null));
  await new Promise<void>((resolve) => {
    const close = () => {
      watcher.close();
      resolve();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

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

async function pruneI18n(dryRun: boolean): Promise<void> {
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
  process.stdout.write(`locales: ${relative(ROOT, dirname(EN_DIR))}\n`);
}

async function main() {
  const mode = parseMode();
  if (mode === 'check') await checkCatalog();
  else if (mode === 'watch') await watchCatalog();
  else if (mode === 'prune') await pruneI18n(false);
  else if (mode === 'prune-dry-run') await pruneI18n(true);
  else await writeCatalog(mode);
}

if (import.meta.main) {
  await main();
}

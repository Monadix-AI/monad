import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  type Catalog,
  type Diagnostic,
  type LocaleCatalog,
  PARAGLIDE_INPUT_DIR,
  PARAGLIDE_OUTPUT_DIR,
  PARAGLIDE_SCOPE_NAMES,
  type ParaglideScope,
  PRUNED_PARAGLIDE_FILES,
  SHARED_RUNTIME_SCOPE
} from './constants';

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

export function renderParaglideInputs(locales: LocaleCatalog[], fallback: LocaleCatalog): Map<string, string> {
  const files = new Map<string, string>();
  for (const locale of locales) {
    for (const scope of PARAGLIDE_SCOPE_NAMES) {
      const messages = messagesForScope(locale, fallback, scope);
      files.set(join(PARAGLIDE_INPUT_DIR, scope, `${locale.locale}.json`), renderParaglideInput(messages));
    }
  }
  return files;
}

export async function writeFiles(files: Map<string, string>): Promise<void> {
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

export async function runParaglideCompiles(scopes: readonly ParaglideScope[] = PARAGLIDE_SCOPE_NAMES): Promise<void> {
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

export async function currentGeneratedFiles(
  generated: string,
  generatedMessages: string,
  paraglideInputs: Map<string, string>,
  generatedPath: string,
  generatedMessagesPath: string
): Promise<boolean> {
  const expected = new Map([
    [generatedPath, generated],
    [generatedMessagesPath, generatedMessages],
    ...paraglideInputs
  ]);
  const inputFiles = await collectFiles(PARAGLIDE_INPUT_DIR).catch(() => []);
  const actual = await readExistingFiles([generatedPath, generatedMessagesPath, ...inputFiles]);
  return generatedFilesMatch(expected, actual);
}

export async function paraglideOutputsExist(): Promise<boolean> {
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

export async function checkParaglideCompiles(
  inputFiles: Map<string, string>,
  diagnostics: Diagnostic[]
): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'monad-paraglide-'));
  try {
    const tmpInputDir = join(tmp, 'packages', 'i18n', 'generated', 'paraglide-input');
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

export async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

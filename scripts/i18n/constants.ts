import { join } from 'node:path';

export const ROOT = join(import.meta.dir, '..', '..');
export const LOCALES_DIR = join(ROOT, 'packages', 'i18n', 'src', 'locales');
export const EN_DIR = join(LOCALES_DIR, 'en');
export const ZH_DIR = join(LOCALES_DIR, 'zh');
export const I18N_SRC_DIR = join(ROOT, 'packages', 'i18n', 'src');
export const I18N_GENERATED_DIR = join(ROOT, 'packages', 'i18n', 'generated');
export const GENERATED_PATH = join(I18N_SRC_DIR, 'catalog-types.ts');
export const GENERATED_MESSAGES_PATH = join(I18N_SRC_DIR, 'messages.generated.ts');
export const PARAGLIDE_INPUT_DIR = join(I18N_GENERATED_DIR, 'paraglide-input');
export const PARAGLIDE_OUTPUT_DIR = join(I18N_GENERATED_DIR, 'paraglide');
export const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
export const PARAM_RE = /{{\s*([A-Za-z_$][\w$]*)\s*}}/g;
export const PARAGLIDE_SCOPES = {
  common: ['channel', 'cmd', 'daemon', 'init'],
  cli: ['cli'],
  web: ['web']
} as const;
export const PARAGLIDE_SCOPE_NAMES = Object.keys(PARAGLIDE_SCOPES).sort() as ParaglideScope[];
export const SHARED_RUNTIME_SCOPE = 'common' satisfies ParaglideScope;
export const PRUNED_PARAGLIDE_FILES = ['registry.d.ts', 'registry.js', 'server.d.ts', 'server.js'];
export const SOURCE_EXTENSIONS = new Set([
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
export const IGNORED_PARTS = new Set([
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

export type Catalog = Record<string, string>;
export type ParaglideScope = keyof typeof PARAGLIDE_SCOPES;

export interface LocaleCatalog {
  locale: string;
  messages: Catalog;
  namespaces: Record<string, Catalog>;
}

export interface Diagnostic {
  locale: string;
  message: string;
}

export interface Namespace {
  file: string;
  messages: Record<string, string>;
}

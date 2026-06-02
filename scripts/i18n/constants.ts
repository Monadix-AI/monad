import { join } from 'node:path';

export const ROOT = join(import.meta.dir, '..', '..');
export const LOCALES_DIR = join(ROOT, 'packages', 'i18n', 'src', 'locales');
export const EN_DIR = join(LOCALES_DIR, 'en');
export const ZH_DIR = join(LOCALES_DIR, 'zh');
export const I18N_SRC_DIR = join(ROOT, 'packages', 'i18n', 'src');
export const GENERATED_PATH = join(I18N_SRC_DIR, 'catalog-types.ts');
export const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
export const PARAM_RE = /{\s*([A-Za-z_$][\w$]*)\s*}/g;
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

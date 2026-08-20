import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
export const LOCALES_DIR = join(ROOT, 'packages', 'i18n', 'src', 'locales');
const I18N_SRC_DIR = join(ROOT, 'packages', 'i18n', 'src');
export const GENERATED_PATH = join(I18N_SRC_DIR, 'catalog-types.ts');
export const PLURAL_SUFFIXES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
export const PARAM_RE = /{\s*([A-Za-z_$][\w$]*)\s*}/g;
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

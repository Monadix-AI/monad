import { fileURLToPath } from 'node:url';

/** Absolute path to the directory containing builtin locale namespace files
 *  (<lng>/<namespace>.json). Loaded by the daemon via loadLocalePacksFromDir.
 *  Server/Bun only — do NOT import this from browser bundles. */
export const BUILTIN_LOCALES_DIR = fileURLToPath(new URL('./locales', import.meta.url));

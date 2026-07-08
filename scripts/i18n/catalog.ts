import { readdir, rm } from 'node:fs/promises';
import { relative } from 'node:path';

import {
  type Catalog,
  type Diagnostic,
  GENERATED_MESSAGES_PATH,
  GENERATED_PATH,
  LOCALES_DIR,
  type LocaleCatalog,
  PARAGLIDE_INPUT_DIR,
  PARAGLIDE_SCOPE_NAMES,
  PARAM_RE,
  type ParaglideScope,
  PLURAL_SUFFIXES
} from './constants';
import {
  checkParaglideCompiles,
  currentGeneratedFiles,
  paraglideOutputsExist,
  renderParaglideInputs,
  runParaglideCompiles,
  writeFiles
} from './paraglide';

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
    const localeDir = `${LOCALES_DIR}/${locale}`;
    const files = (await readdir(localeDir, { withFileTypes: true }))
      .filter((file) => file.isFile() && file.name.endsWith('.json'))
      .map((file) => file.name)
      .sort();
    const messages: Catalog = {};
    const namespaces: Record<string, Catalog> = {};

    for (const file of files) {
      const path = `${localeDir}/${file}`;
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

function identifierPart(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9]+/g, '_');
  const prefixed = /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
  return prefixed || '_';
}

function renderMessagesGenerated(en: LocaleCatalog): string {
  const namespaces = Object.keys(en.namespaces).sort();
  const builtinLocales = ['en', 'zh'] as const;

  const imports = builtinLocales
    .flatMap((locale) =>
      namespaces.map((namespace) => {
        const id = `${identifierPart(locale)}_${identifierPart(namespace)}`;
        return `import ${id} from './locales/${locale}/${namespace}.json';`;
      })
    )
    .join('\n');

  const mergedByLocale = builtinLocales
    .map((locale) => {
      const ids = namespaces.map((namespace) => `${identifierPart(locale)}_${identifierPart(namespace)}`).join(', ');
      return `export const ${locale}Messages = mergeCatalogs([${ids}]);`;
    })
    .join('\n');

  return `// Generated by scripts/i18n.ts. Do not edit by hand.\n\n${imports}\n\nfunction mergeCatalogs(catalogs: readonly Record<string, string>[]): Record<string, string> {\n  return Object.assign({}, ...catalogs);\n}\n\n${mergedByLocale}\n`;
}

export async function writeCatalog(
  mode: 'write' | 'write-if-stale',
  scopes: readonly ParaglideScope[] = PARAGLIDE_SCOPE_NAMES
) {
  const locales = await loadLocales();
  const diagnostics = validateCatalogs(locales);
  const en = locales.find((locale) => locale.locale === 'en');
  if (!en) throw new Error('canonical English locale is missing');
  if (!locales.find((locale) => locale.locale === 'zh')) throw new Error('builtin zh locale is missing');

  const generated = renderGenerated(en);
  const generatedMessages = renderMessagesGenerated(en);
  const paraglideInputs = renderParaglideInputs(locales, en);

  if (mode === 'write' || mode === 'write-if-stale') {
    if (
      mode === 'write-if-stale' &&
      (await currentGeneratedFiles(
        generated,
        generatedMessages,
        paraglideInputs,
        GENERATED_PATH,
        GENERATED_MESSAGES_PATH
      )) &&
      (await paraglideOutputsExist())
    ) {
      process.stdout.write('i18n catalog types up to date\n');
    } else {
      await Bun.write(GENERATED_PATH, generated);
      await Bun.write(GENERATED_MESSAGES_PATH, generatedMessages);
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

export async function checkCatalog() {
  const locales = await loadLocales();
  const diagnostics = validateCatalogs(locales);
  const en = locales.find((locale) => locale.locale === 'en');
  if (!en) throw new Error('canonical English locale is missing');
  if (!locales.find((locale) => locale.locale === 'zh')) throw new Error('builtin zh locale is missing');
  const paraglideInputs = renderParaglideInputs(locales, en);

  await checkParaglideCompiles(paraglideInputs, diagnostics);

  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) process.stderr.write(`[${diagnostic.locale}] ${diagnostic.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('i18n catalog check passed\n');
}

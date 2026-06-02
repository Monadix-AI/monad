'use client';

import type { StrictTranslateForNamespace, WebMessageId } from '@monad/i18n';
import type { ReactElement, ReactNode } from 'react';

import { useGetCatalogQuery, useGetLocaleQuery } from '@monad/client-rtk';
import { buildCatalogOverlay, createI18n } from '@monad/i18n';
import { cloneElement, createContext, isValidElement, useContext, useEffect, useMemo } from 'react';

export type TFn = StrictTranslateForNamespace<'web'>;
type RichTranslate = (key: WebMessageId, values?: Record<string, string | number>) => string;

const I18nContext = createContext<TFn>(createI18n({ locale: 'en', packs: [] }).t as TFn);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { data: active } = useGetLocaleQuery();
  const locale = active ?? 'en';
  const { data: catalog } = useGetCatalogQuery(locale);

  const t = useMemo(() => {
    const overlay = catalog?.messages ? buildCatalogOverlay(locale, catalog.messages) : {};
    return createI18n({
      locale,
      packs: [{ locale, name: locale, messages: overlay }]
    }).t as TFn;
  }, [locale, catalog]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): TFn {
  return useContext(I18nContext);
}

export function I18nTrans({
  components,
  i18nKey,
  values
}: {
  components?: Record<string, ReactElement>;
  i18nKey: WebMessageId;
  values?: Record<string, string | number>;
}) {
  const t = useT();
  const translate = t as unknown as RichTranslate;
  return <>{renderRichText(translate(i18nKey, values), components)}</>;
}

function renderRichText(text: string, components: Record<string, ReactElement> = {}): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tagRe = /<([A-Za-z][\w-]*)>(.*?)<\/\1>|<([A-Za-z][\w-]*)\s*\/>/gs;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(tagRe)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const tag = match[1] ?? match[3] ?? '';
    const template = components[tag];
    const content = match[2] ?? '';
    if (template && isValidElement(template)) {
      nodes.push(
        content
          ? cloneElement(template, { key: `${tag}-${index++}` }, content)
          : cloneElement(template, { key: `${tag}-${index++}` })
      );
    } else {
      nodes.push(content);
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

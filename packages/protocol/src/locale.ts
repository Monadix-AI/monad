// Wire schemas for the global locale setting + the message catalog the web UI fetches. Schema-first
// (the zod schema is the definition; types derive). The daemon resolves `locale` against the
// language packs registered by `locale` atom packs; an unknown tag falls back to English.

import { z } from 'zod';

export const getLocaleResponseSchema = z.object({ locale: z.string() });
export type GetLocaleResponse = z.infer<typeof getLocaleResponseSchema>;

export const setLocaleRequestSchema = z.object({ locale: z.string().min(1) });
export type SetLocaleRequest = z.infer<typeof setLocaleRequestSchema>;

export const localeInfoSchema = z.object({ locale: z.string(), name: z.string() });
export type LocaleInfo = z.infer<typeof localeInfoSchema>;

export const listLocalesResponseSchema = z.object({ locales: z.array(localeInfoSchema) });
export type ListLocalesResponse = z.infer<typeof listLocalesResponseSchema>;

export const localeCatalogQuerySchema = z.object({ locale: z.string().optional() });
export type LocaleCatalogQuery = z.infer<typeof localeCatalogQuerySchema>;

export const localeCatalogResponseSchema = z.object({
  locale: z.string(),
  messages: z.record(z.string(), z.string())
});
export type LocaleCatalogResponse = z.infer<typeof localeCatalogResponseSchema>;

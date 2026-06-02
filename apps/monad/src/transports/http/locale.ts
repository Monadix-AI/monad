import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  getLocaleResponseSchema,
  listLocalesResponseSchema,
  localeCatalogQuerySchema,
  localeCatalogResponseSchema,
  okResponseSchema,
  setLocaleRequestSchema
} from '@monad/protocol';
import { Elysia } from 'elysia';

// HTTP-only surface: contract declared inline; reusable wire schemas come from @monad/protocol.

/** Mounted under /v1/settings: the single global locale setting + the registered-locale list. */
export function createLocaleSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .get('/locale', async () => handlers.locale.get(), {
      response: { 200: getLocaleResponseSchema },
      detail: { summary: 'Get active locale', description: 'Returns the current global locale tag.' }
    })
    .put('/locale', async ({ body }) => handlers.locale.set(body), {
      body: setLocaleRequestSchema,
      response: { 200: okResponseSchema },
      detail: { summary: 'Set active locale', description: 'Persists the global locale and hot-reloads i18n.' }
    })
    .get('/locales', async () => handlers.locale.list(), {
      response: { 200: listLocalesResponseSchema },
      detail: { summary: 'List available locales', description: 'Locales offered by registered language packs.' }
    });
}

/** Mounted under /v1: the resolved message catalog for a locale (raw templates; the web formats them). */
export function createLocaleCatalogController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] }).get(
    '/i18n/catalog',
    async ({ query }) => handlers.locale.catalog({ locale: query.locale }),
    {
      query: localeCatalogQuerySchema,
      response: { 200: localeCatalogResponseSchema },
      detail: {
        summary: 'Get message catalog',
        description: 'Raw message templates for a locale (fallback to English).'
      }
    }
  );
}

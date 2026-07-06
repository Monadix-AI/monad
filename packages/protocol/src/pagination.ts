// Shared pagination envelopes. Kept dependency-free (only `httpUrlSchema`) so any wire-contract
// file — including ones `rpc/control.ts` itself depends on, like `approvals.ts` and `memory.ts` —
// can extend these without a circular import back through `rpc/control.ts`.

import { z } from 'zod';

import { httpUrlSchema } from './url.ts';

/** Shared query fields for offset-based (page-number) pagination. */
export const offsetPaginationQuerySchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional()
});
export type OffsetPaginationQuery = z.infer<typeof offsetPaginationQuerySchema>;

/** Shared response envelope fields for offset-based pagination. */
export const offsetPaginationResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  next: httpUrlSchema.optional(),
  previous: httpUrlSchema.optional()
});
export type OffsetPaginationResponse = z.infer<typeof offsetPaginationResponseSchema>;

/** Shared query fields for cursor-based (infinite-load) pagination. */
export const cursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  before: z.string().optional()
});
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

/** Shared response envelope fields for cursor-based pagination. */
export const cursorPaginationResponseSchema = z.object({
  nextCursor: z.string().optional(),
  next: httpUrlSchema.optional(),
  previous: httpUrlSchema.optional()
});
export type CursorPaginationResponse = z.infer<typeof cursorPaginationResponseSchema>;

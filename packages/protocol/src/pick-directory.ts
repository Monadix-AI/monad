import { z } from 'zod';

/** Open a native folder picker on the daemon host. Both fields are optional UI hints. */
export const pickDirectoryRequestSchema = z.object({
  prompt: z.string().optional(),
  defaultPath: z.string().optional()
});
export type PickDirectoryRequest = z.infer<typeof pickDirectoryRequestSchema>;

/** Chosen absolute path, or `null` when the user cancelled or no picker is available. */
export const pickDirectoryResponseSchema = z.object({
  path: z.string().nullable()
});
export type PickDirectoryResponse = z.infer<typeof pickDirectoryResponseSchema>;

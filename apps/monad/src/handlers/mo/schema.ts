// Mo desktop-sprite wire schemas. Local to the daemon on purpose: the only consumers are the
// daemon's own mo handler + controller — the native sprite speaks C (no TS types) and the web
// client never touches Mo — so these don't belong in the cross-package @monad/protocol barrel.
// Adding them there tips the web client's Eden-treaty type inference past TS's instantiation
// ceiling (the treaty type is already near the limit), degrading every web endpoint's types.

import { sessionIdSchema } from '@monad/protocol';
import { z } from 'zod';

// DoS guards: an unbounded path list / prompt lets one request exhaust memory.
const MO_DROP_MAX_PATHS = 20;
const MO_DROP_PROMPT_MAX = 10_000;
const MO_DROP_PATH_MAX = 4_096;

export const moDropRequestSchema = z.object({
  /** Absolute local paths of the dropped file(s)/folder(s). */
  paths: z.array(z.string().min(1).max(MO_DROP_PATH_MAX)).min(1).max(MO_DROP_MAX_PATHS),
  /** Free text the user typed into Mo's input box (optional). */
  prompt: z.string().max(MO_DROP_PROMPT_MAX).optional()
});
export type MoDropRequest = z.infer<typeof moDropRequestSchema>;

export const moDropResponseSchema = z.object({ sessionId: sessionIdSchema });
export type MoDropResponse = z.infer<typeof moDropResponseSchema>;

export const moStatusResponseSchema = z.object({
  running: z.boolean(),
  /** The web UI URL Mo opens when clicked (daemon-served SPA, or the dev web server). */
  webUrl: z.string().optional()
});

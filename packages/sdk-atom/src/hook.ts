// Hook authoring surface — the `hook` atom of the unified atom pack SDK.

import type { HookEvent, HookInput, HookOutput } from '@monad/protocol';

export type { HookEvent, HookInput, HookOutput };

/** An in-process typed lifecycle hook. Returning nothing is "proceed"; see HookOutput for the
 * deny/ask/mutate/inject vocabulary. `matcher` (a regex string) filters tool events by tool name. */
export type HookHandler = (input: HookInput) => HookOutput | undefined | Promise<HookOutput | undefined>;

export interface HookDefinition {
  event: HookEvent;
  matcher?: string;
  handler: HookHandler;
  /** What to do when this hook fails (handler throws). `allow` (default) skips it and proceeds;
   *  `deny` fails closed — a crashing PreToolUse guard blocks the call rather than waving it
   *  through. Use `deny` for security-critical hooks where a silent failure must not be permissive. */
  onError?: 'allow' | 'deny';
}

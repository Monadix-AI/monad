#!/usr/bin/env -S bun --watch

// Dev entry point: re-exports main, run with bun --watch (see shebang).

export * from './main.ts';

import { exitCodeFor } from './commands/types.ts';
import { main } from './main.ts';

export async function runDev(): Promise<number> {
  try {
    await main();
    // `bun --watch` keeps the process alive after command completion unless we exit.
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message) process.stderr.write(`${message}\n`);
    return exitCodeFor(err);
  }
}

if (import.meta.main) {
  const code = await runDev();
  process.exit(code);
}

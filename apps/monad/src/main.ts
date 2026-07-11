import { startDaemon } from '#/application/lifecycle.ts';

export type { App } from '#/application/lifecycle.ts';

export { startDaemon } from '#/application/lifecycle.ts';

if (import.meta.main) {
  startDaemon().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

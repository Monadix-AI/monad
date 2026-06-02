import type { CommandDef } from './types.ts';

import { resolve } from 'node:path';

// Run monad as an Agent Client Protocol agent on stdio, for editor integration (Zed, etc.).
// The editor launches `monad acp` and speaks ACP JSON-RPC over this process's stdin/stdout, so we
// spawn the daemon in --acp mode with stdio inherited — a transparent passthrough. Nothing may be
// written to stdout here (it is the protocol channel); the CLI keeps logs silent by default.
export const command: CommandDef = {
  local: true,
  name: 'acp',
  hidden: true, // advanced/machine mode — kept out of the top-level usage table
  synopsis: 'acp',
  description: 'run as an Agent Client Protocol agent on stdio (editor integration, e.g. Zed)',
  descriptionKey: 'cli.cmd.acp.desc',
  async run() {
    const devEntry = resolve(import.meta.dir, '../../../monad/src/main.ts');
    const isDevEntry = await Bun.file(devEntry).exists();
    const argv = isDevEntry ? ['bun', devEntry, '--acp'] : [process.execPath, 'daemon', '--acp'];
    const proc = Bun.spawn(argv, {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit'
    });
    process.exit(await proc.exited);
  }
};

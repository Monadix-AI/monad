import type { CommandDef } from './types.ts';

import { MONAD_VERSION } from '@monad/protocol';

import { bold, json, out } from '../lib/output.ts';

export const command: CommandDef = {
  local: true,
  name: 'version',
  synopsis: 'version',
  description: 'print the Monad version',
  descriptionKey: 'cli.cmd.version.desc',
  async run() {
    json({ version: MONAD_VERSION });
    out(bold(MONAD_VERSION));
  }
};

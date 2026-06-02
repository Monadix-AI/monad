import type { CommandDef } from './types.ts';

import { runMonadAppServer } from '../app-server/bridge.ts';

export const command: CommandDef = {
  local: true,
  name: 'app-server',
  hidden: true,
  synopsis: 'app-server',
  description: 'run the local Monad MeshAgent app-server protocol over stdio',
  descriptionKey: 'cli.cmd.appServer.desc',
  flags: {
    'list-agents': {
      type: 'boolean',
      description: 'print Studio agents as JSON and exit',
      descriptionKey: 'cli.appServer.flag.listAgents'
    }
  },
  async run({ flags }) {
    await runMonadAppServer({ listAgents: flags.listAgents === true || flags['list-agents'] === true });
  }
};

import { serveAgentFacingMcpStdio } from '../lib/agent-facing-mcp-server.ts';
import { type CommandDef, usageError } from './types.ts';

export const command: CommandDef = {
  name: 'native-agent',
  hidden: true,
  synopsis: 'native-agent mcp-server',
  description: 'run agent-facing native agent utilities',
  async run({ positionals, client }) {
    if (positionals[0] !== 'mcp-server') throw usageError('usage: monad native-agent mcp-server');
    await serveAgentFacingMcpStdio(client);
  }
};

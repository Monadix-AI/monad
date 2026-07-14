import type { ListMcpServerStatusResponse } from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { getPaths, loadConfig, saveAll } from '@monad/home';

import { cyan, dim, green, json, out, red } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { CliError, EXIT } from './types.ts';

// Persist the monadix enable toggle to config.json. The daemon's config watcher hot-applies it, so
// the synthesized MCP preset appears/disappears without a restart.
async function setEnabled(enabled: boolean): Promise<void> {
  const paths = getPaths();
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new CliError(`${red('✖')} run "monad init" first`, EXIT.CONFIG);
  cfg.monadix = { ...cfg.monadix, enabled };
  await saveAll(paths.config, paths.profile, cfg);
}

// Monadix is the first-party cross-owner collaboration network. This is sugar over `monad config set
// monadix.enabled …` + `monad mcp authorize monadix`, giving接入 a single obvious entry point.
export const command: CommandDef = {
  name: 'monadix',
  synopsis: 'monadix <login|enable|disable|status>',
  description: 'connect to the Monadix collaboration network (enable + one-time OAuth login)',
  async run({ positionals: args, client }) {
    const [sub] = args;
    const servers = client.treaty.v1.settings['mcp-servers'];

    // Enable the preset, then run the interactive OAuth once. This is the headline one-command接入.
    if (sub === 'login' || sub === 'auth' || sub === undefined) {
      await setEnabled(true);
      out(dim('opening Monadix sign-in…'));
      requireTreatyData(await servers({ name: 'monadix' }).authorize.post());
      out(`${green('✓')} ${cyan('monadix')} ${dim('connected')}`);
      return;
    }

    if (sub === 'enable') {
      await setEnabled(true);
      requireTreatyData(await servers({ name: 'monadix' }).reconnect.post());
      out(`${green('✓')} monadix ${dim('enabled — run "monad monadix login" to sign in')}`);
      return;
    }

    if (sub === 'disable') {
      await setEnabled(false);
      out(`${green('✓')} monadix ${dim('disabled')}`);
      return;
    }

    if (sub === 'status' || sub === 'st') {
      const { servers: all } = requireTreatyData<ListMcpServerStatusResponse>(await servers.status.get());
      const mine = all.filter((s) => s.name === 'monadix');
      json(mine);
      return;
    }

    throw new CliError('usage: monad monadix <login|enable|disable|status>', EXIT.USAGE);
  }
};

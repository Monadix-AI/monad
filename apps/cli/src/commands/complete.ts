import type { CommandDef } from './types.ts';

import { getPaths, loadConfig } from '@monad/home';

import { requireTreatyData } from '../lib/treaty.ts';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flattenKeys(v as Record<string, unknown>, key) : [key];
  });
}

// Internal: emit dynamic completion candidates (one per line) for the shell completion scripts.
// Hidden, and must NEVER throw or print noise — a failing completion would break the user's shell.
export const command: CommandDef = {
  name: '__complete',
  hidden: true,
  synopsis: '__complete <sessions|providers|config-keys>',
  description: 'internal: dynamic shell-completion candidates',
  async run({ positionals, client }) {
    const type = positionals[0];
    try {
      if (type === 'sessions') {
        const { sessions } = requireTreatyData(
          await client.treaty.v1.sessions.get({ query: { archived: undefined, limit: undefined, offset: undefined } })
        );
        process.stdout.write(`${sessions.map((s) => s.id).join('\n')}\n`);
      } else if (type === 'providers') {
        const { providers } = requireTreatyData(await client.treaty.v1.settings.model.providers.get());
        process.stdout.write(`${providers.map((p) => p.id).join('\n')}\n`);
      } else if (type === 'config-keys') {
        const cfg = await loadConfig(getPaths().config);
        if (cfg) process.stdout.write(`${flattenKeys(cfg as unknown as Record<string, unknown>).join('\n')}\n`);
      }
    } catch {
      // Completion must stay silent on any error (daemon down, no config, …).
    }
  }
};

import type { CommandDef } from './types.ts';

import { newId } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

// Peer resource: configure other monad daemons this one can delegate tasks to over their
// OpenAI-compat API. Mirrors `monad channel` in shape. Peers are system config — changes apply on
// the next daemon start. The token lands in auth.json via `peer token`, never config.json.
export const command: CommandDef = {
  name: 'peer',
  synopsis: 'peer <list|add|token|enable|disable|remove> [arg]',
  description: 'manage peer daemons for task delegation',
  descriptionKey: 'cli.cmd.peer.desc',
  flags: {
    label: { type: 'string', description: 'display label (peer add)' },
    agent: { type: 'string', description: 'default target agent on the peer (peer add)' },
    id: { type: 'string', description: 'explicit peer id (peer add; default peer_<ulid>)' }
  },
  async run({ positionals: args, flags, client }) {
    const [action, ...rest] = args;
    const peers = client.treaty.v1.settings.peers;

    switch (action) {
      case 'add': {
        const baseUrl = rest[0];
        if (!baseUrl) throw new Error(t('cli.peer.addUsage'));
        const id = (typeof flags.id === 'string' && flags.id ? flags.id : newId('peer')) as `peer_${string}`;
        const peer = {
          id,
          label: typeof flags.label === 'string' && flags.label ? flags.label : id,
          baseUrl,
          defaultAgent: typeof flags.agent === 'string' && flags.agent ? flags.agent : 'default',
          // Created disabled; setting a token enables it.
          enabled: false
        };
        requireTreatyData(await peers.put({ peer }));
        out(green(t('cli.peer.added')) + dim(`  ${id}  (${baseUrl})`));
        out(dim(t('cli.peer.addNext', { id })));
        return;
      }

      case 'token': {
        const [id, token] = rest;
        if (!id || !token) throw new Error(t('cli.peer.tokenUsage'));
        requireTreatyData(await peers({ id }).credential.put({ token }));
        out(green(t('cli.peer.tokenSet')) + dim(`  ${id}`));
        return;
      }

      case 'list':
      case 'ls':
      case undefined: {
        const { peers: list } = requireTreatyData(await peers.get());
        json(list);
        if (list.length === 0) {
          out(dim(t('cli.empty.peers')));
          return;
        }
        for (const p of list) {
          const state = p.enabled ? '' : red(t('cli.atom.disabled'));
          out(cyan(p.id) + dim('  ') + bold(p.label) + dim(`  ${p.baseUrl}  → ${p.defaultAgent}`) + state);
        }
        return;
      }

      case 'enable':
      case 'disable': {
        const id = rest[0];
        if (!id) throw new Error(t('cli.peer.idUsage'));
        requireTreatyData(await (action === 'enable' ? peers({ id }).enable.post() : peers({ id }).disable.post()));
        out(green(action === 'enable' ? t('cli.enabled') : t('cli.disabled')) + dim(`  ${id}`));
        return;
      }

      case 'remove':
      case 'rm': {
        const id = rest[0];
        if (!id) throw new Error(t('cli.peer.idUsage'));
        requireTreatyData(await peers({ id }).delete());
        out(green(t('cli.removed')) + dim(`  ${id}`));
        return;
      }

      default:
        throw new Error(t('cli.peer.unknownAction', { action: String(action) }));
    }
  }
};

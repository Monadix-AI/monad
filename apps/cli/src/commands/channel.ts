import type { CommandDef } from './types.ts';

import { newId } from '@monad/protocol';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

const POLICIES = ['allowlist', 'pairing', 'open', 'disabled'] as const;

// Channel resource: list/status plus the operator side of the pairing flow (pairings/pair) and
// enable/disable. Mirrors `monad atom` in shape. Channel CRUD with secrets stays in the web UI.
export const command: CommandDef = {
  name: 'channel',
  aliases: ['chan'],
  synopsis: 'channel <list|status|add|token|pairings|pair|enable|disable|remove> [arg]',
  description: 'manage channels and approve pairing requests',
  descriptionKey: 'cli.cmd.channel.desc',
  flags: {
    label: { type: 'string', description: 'display label (channel add)' },
    agent: { type: 'string', description: 'agent id this channel uses (channel add)' },
    id: { type: 'string', description: 'explicit channel id (channel add; default chn_<12-char-nanoid>)' },
    policy: { type: 'string', description: 'access policy: allowlist|pairing|open|disabled (channel add)' }
  },
  async run({ positionals: args, flags, client }) {
    const [action, ...rest] = args;
    const channels = client.treaty.v1.settings.channels;

    switch (action) {
      case 'add': {
        const type = rest[0];
        if (!type) throw new Error(t('cli.channel.addUsage'));
        const policy = POLICIES.includes(flags.policy as (typeof POLICIES)[number])
          ? (flags.policy as (typeof POLICIES)[number])
          : 'allowlist';
        const id = (typeof flags.id === 'string' && flags.id ? flags.id : newId('chn')) as `chn_${string}`;
        const channel = {
          id,
          type,
          label: typeof flags.label === 'string' && flags.label ? flags.label : type,
          // Created disabled so it doesn't try to connect before its token is set.
          enabled: false,
          agentId: typeof flags.agent === 'string' && flags.agent ? flags.agent : undefined,
          options: {},
          allowlist: { policy, allowAllUsers: false, allowedUsers: [] as string[] },
          groupPolicy: { requireMention: true },
          mapping: { granularity: 'per-conversation' as const },
          rateLimitPerMin: 20
        };
        requireTreatyData(await channels({ id }).put({ channel }));
        out(green(t('cli.channel.added')) + dim(`  ${id}  (${type}, ${policy})`));
        out(dim(t('cli.channel.addNext', { id })));
        return;
      }

      case 'token': {
        const [id, token] = rest;
        if (!id || !token) throw new Error(t('cli.channel.tokenUsage'));
        requireTreatyData(await channels({ id }).credential.put({ token }));
        out(green(t('cli.channel.tokenSet')) + dim(`  ${id}`));
        return;
      }
      case 'list':
      case 'ls':
      case undefined: {
        const { channels: list } = requireTreatyData(await channels.get());
        json(list);
        if (list.length === 0) {
          out(dim(t('cli.empty.channels')));
          return;
        }
        for (const c of list) {
          const policy = c.allowlist.allowAllUsers ? 'open' : (c.allowlist.policy ?? 'allowlist');
          const state = c.enabled ? '' : red(t('cli.atom.disabled'));
          out(cyan(c.id) + dim('  ') + bold(c.type) + dim(`  ${c.label}  [${policy}]`) + state);
        }
        return;
      }

      case 'status': {
        const { statuses } = requireTreatyData(await channels.status.get());
        json(statuses);
        for (const s of statuses) {
          const dot = s.connected ? green('●') : s.hasToken ? yellow('○') : red('○');
          const extra = s.lastError ? red(`  ${s.lastError}`) : dim(`  ${s.activeConversations} active`);
          out(`${dot} ${cyan(s.id)}${dim(`  ${s.type}`)}${extra}`);
        }
        return;
      }

      case 'pairings': {
        const id = rest[0];
        if (!id) throw new Error(t('cli.channel.pairingsUsage'));
        const { pairings } = requireTreatyData(await channels({ id }).pairings.get());
        json(pairings);
        if (pairings.length === 0) {
          out(dim(t('cli.channel.noPairings')));
          return;
        }
        for (const p of pairings) {
          out(bold(p.code) + dim('  ') + (p.senderDisplay ?? p.userId) + dim(`  ${p.userId}  expires ${p.expiresAt}`));
        }
        return;
      }

      case 'pair': {
        const [id, code] = rest;
        if (!id || !code) throw new Error(t('cli.channel.pairUsage'));
        requireTreatyData(await channels({ id }).pair.post({ code }));
        out(green(t('cli.channel.paired')) + dim(`  ${id}`));
        return;
      }

      case 'enable':
      case 'disable': {
        const id = rest[0];
        if (!id) throw new Error(t('cli.channel.idUsage'));
        requireTreatyData(
          await (action === 'enable' ? channels({ id }).enable.post() : channels({ id }).disable.post())
        );
        out(green(action === 'enable' ? t('cli.enabled') : t('cli.disabled')) + dim(`  ${id}`));
        return;
      }

      case 'remove':
      case 'rm': {
        const id = rest[0];
        if (!id) throw new Error(t('cli.channel.idUsage'));
        requireTreatyData(await channels({ id }).delete());
        out(green(t('cli.removed')) + dim(`  ${id}`));
        return;
      }

      default:
        throw new Error(t('cli.channel.unknownAction', { action: String(action) }));
    }
  }
};

import type { CommandDef } from './types.ts';

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

export const command: CommandDef = {
  name: 'atom',
  synopsis: 'atom <list|install|update|remove|scaffold> [arg]',
  description: 'manage atom packs (channels, tools, …)',
  descriptionKey: 'cli.cmd.atom.desc',
  async run({ positionals: args, globals, client }) {
    const [action, ...rest] = args;
    const atoms = client.treaty.v1.atoms;

    switch (action) {
      case 'scaffold': {
        // Generate a ready-to-build channel atom pack skeleton. Local FS only — no daemon needed.
        const type = rest.find((a) => !a.startsWith('-'));
        if (!type || !/^[a-z][a-z0-9-]*$/.test(type)) throw new Error(t('cli.atom.scaffoldUsage'));
        const dir = resolve(rest.find((a) => !a.startsWith('-') && a !== type) ?? `${type}-channel`);
        await mkdir(`${dir}/dist`, { recursive: true });
        for (const [file, content] of Object.entries(channelScaffold(type))) {
          await writeFile(`${dir}/${file}`, content, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'EEXIST') throw new Error(t('cli.atom.scaffoldExists', { file }));
            throw err;
          });
        }
        out(green(t('cli.atom.scaffolded', { type })) + dim(`  ${dir}`));
        out(dim(t('cli.atom.scaffoldNext', { dir })));
        return;
      }

      case 'list':
      case 'ls':
      case undefined: {
        const { atomPacks: list } = requireTreatyData(await atoms.get());
        json(list);
        if (list.length === 0) {
          out(dim(t('cli.empty.atoms')));
          return;
        }
        for (const p of list) {
          const kinds = p.atoms.join(', ') || '—';
          const state = p.enabled ? '' : red(t('cli.atom.disabled'));
          // Show the display name; append the operable id when it differs (a disambiguated dir).
          const label = p.displayName && p.displayName !== p.name ? `${p.displayName} ${dim(`(${p.name})`)}` : p.name;
          out(cyan(label) + dim('  ') + bold(kinds) + dim(`  ${p.source ?? 'drop-in'}`) + state);
        }
        return;
      }

      case 'install':
      case 'add': {
        const source = rest.find((a) => !a.startsWith('-'));
        const consent = globals.yes;
        if (!source) throw new Error(t('cli.atom.installUsage'));
        const res = requireTreatyData(await atoms.install.post({ source, consent }));
        if (res.needsConsent) {
          out(`${yellow(t('cli.atom.requests', { name: res.name }))}${bold(res.atoms.join(', ') || 'none')}`);
          if (res.warnings.length > 0) out(`${red(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
          out(dim(t('cli.atom.consentHint')));
          return;
        }
        out(green(t('cli.installed')) + dim(`  ${res.name}  [${res.atoms.join(', ')}]`));
        if (res.warnings.length > 0) out(`${yellow(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
        if (res.atoms.includes('channel')) out(dim(t('cli.atom.channelHint')));
        return;
      }

      case 'update':
      case 'up': {
        // Re-install from the pack's recorded source (the install pipeline overwrites in place).
        // A github source pinned to a mutable ref / branch picks up new content; a SHA-pinned one
        // is already immutable. Re-consent applies (default-deny) unless --yes, so a changed atom
        // set is re-surfaced. Drop-ins (no source) can't be updated this way.
        const { atomPacks: list } = requireTreatyData(await atoms.get());
        const targets = rest[0] ? list.filter((p) => p.name === rest[0]) : list.filter((p) => p.source);
        if (rest[0] && targets.length === 0) throw new Error(t('cli.atom.notFound', { name: rest[0] }));
        for (const p of targets) {
          if (!p.source) {
            out(yellow(t('cli.atom.noSource', { name: p.name })));
            continue;
          }
          const res = requireTreatyData(await atoms.install.post({ source: p.source, consent: globals.yes }));
          if (res.needsConsent) {
            out(`${yellow(t('cli.atom.requests', { name: res.name }))}${bold(res.atoms.join(', ') || 'none')}`);
            if (res.warnings.length > 0) out(`${red(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
            out(dim(t('cli.atom.consentHint')));
            continue;
          }
          out(green(t('cli.atom.updated')) + dim(`  ${res.name}  [${res.atoms.join(', ')}]`));
          if (res.warnings.length > 0) out(`${yellow(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
        }
        return;
      }

      case 'remove':
      case 'rm': {
        const name = rest[0];
        if (!name) throw new Error(t('cli.atom.removeUsage'));
        requireTreatyData(await atoms({ name }).delete());
        out(green(t('cli.removed')) + dim(`  ${name}`));
        return;
      }

      default:
        throw new Error(t('cli.atom.unknownAction', { action: String(action) }));
    }
  }
};

/** File contents for a starter channel atom pack of the given platform `type`. The author fills in
 *  connect()/send(); the access policy, sessions, rate-limiting and consent are all host-owned. */
function channelScaffold(type: string): Record<string, string> {
  const Type = type.charAt(0).toUpperCase() + type.slice(1);
  return {
    'atom-pack.json': `${JSON.stringify(
      {
        name: `${type}-channel`,
        version: '0.1.0',
        sdkVersion: '0',
        atoms: ['channel'],
        entry: 'dist/atom-pack.js',
        description: `${Type} channel for Monad`
      },
      null,
      2
    )}\n`,
    'package.json': `${JSON.stringify(
      {
        name: `${type}-channel`,
        private: true,
        type: 'module',
        scripts: { build: 'bun build ./atom-pack.ts --target=bun --outfile dist/atom-pack.js' },
        devDependencies: { '@monad/sdk-atom': '*' }
      },
      null,
      2
    )}\n`,
    'atom-pack.ts': `import type { ChannelAdapter, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { defineAtomPack, defineChannel } from '@monad/sdk-atom';

// What the platform can do — drives graceful degradation in the core renderer.
const CAPS = {
  edit: false, // can edit a sent message → enables streaming-via-edit
  typing: false,
  threads: false,
  maxMessageChars: 4096,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

export const ${type}ChannelAtom = defineChannel({
  type: '${type}',
  name: '${Type}',
  capabilities: CAPS,
  // Declare any credentials the operator must provide (stored in auth.json, injected via ctx.secrets).
  envVars: [{ name: '${type.toUpperCase()}_TOKEN', description: '${Type} bot token', required: true, secret: true }],
  create(ctx: ChannelContext): ChannelAdapter {
    const token = ctx.secrets.token;
    return {
      type: '${type}',
      capabilities: CAPS,
      async connect() {
        // 1. Verify \`token\` (throw to fail the connection).
        // 2. Start receiving — for every inbound, call ctx.onMessage(normalized) where normalized is a
        //    ChannelInbound: { chatId, userId, text, kind, commandArgs, nativeMessageId, isSelf, media, at,
        //    chatType?, mentionedSelf? }. Set chatType:'group' + mentionedSelf for group platforms so the
        //    core's require-mention gate works. Stop on ctx.signal.aborted.
        ctx.log('info', '${type}: connected');
      },
      async disconnect() {
        // Stop receiving / close sockets. ctx.signal is also aborted on shutdown.
      },
      async send(chatId: string, content: string): Promise<SentMessage> {
        // Deliver \`content\` to \`chatId\` on the platform. Return an opaque handle for later edits.
        void token;
        return { ref: 'TODO', chatId };
      }
      // Optional: editMessage / startTyping / setCommands / react (gate via CAPS).
    };
  }
});

export default defineAtomPack({
  manifest: {
    name: '${type}-channel',
    version: '0.1.0',
    sdkVersion: '0',
    atoms: ['channel'],
    description: '${Type} channel for Monad'
  },
  channels: [${type}ChannelAtom]
});
`,
    'README.md': `# ${Type} channel for Monad

A third-party \`channel\` atom pack. The adapter does **platform I/O only** — Monad owns sessions,
the access policy (allowlist / pairing / open / disabled), group require-mention, rate-limiting and
the conversation→session mapping. Your adapter never sees a sessionId.

## Build

\`\`\`sh
bun install
bun run build   # → dist/atom-pack.js
\`\`\`

## Install

\`\`\`sh
# Drop-in: copy this folder (atom-pack.json + dist/) into ~/.monad/atoms/${type}-channel/
# or install from a source the daemon can fetch:
monad atom install local:$(pwd)
\`\`\`

Then configure a channel instance pointing at \`type: "${type}"\` and set its credential. The first
install surfaces a consent prompt listing the declared atom kinds (\`channel\`).
`
  };
}

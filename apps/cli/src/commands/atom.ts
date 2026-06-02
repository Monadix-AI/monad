import type { CommandDef, LocalCommandContext } from './types.ts';

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { packageAtomPack } from '../atom-pack/package.ts';
import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

async function runAuthorCommand({ positionals: args, flags }: LocalCommandContext): Promise<boolean> {
  const [action, ...rest] = args;
  if (action === 'scaffold') {
    const type = rest.find((arg) => !arg.startsWith('-'));
    if (!type || !/^[a-z][a-z0-9-]*$/.test(type)) throw new Error(t('cli.atom.scaffoldUsage'));
    const dir = resolve(rest.find((arg) => !arg.startsWith('-') && arg !== type) ?? `${type}-channel`);
    for (const [file, content] of Object.entries(channelScaffold(type))) {
      await mkdir(resolve(dir, file, '..'), { recursive: true });
      await writeFile(`${dir}/${file}`, content, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') throw new Error(t('cli.atom.scaffoldExists', { file }));
        throw err;
      });
    }
    out(green(t('cli.atom.scaffolded', { type })) + dim(`  ${dir}`));
    out(dim(t('cli.atom.scaffoldNext', { dir })));
    return true;
  }

  if (action === 'pack') {
    const sourceDir = resolve(rest[0] ?? '.');
    const output = typeof flags.out === 'string' ? resolve(flags.out) : undefined;
    const result = await packageAtomPack({ sourceDir, output });
    json(result);
    out(`${green(t('cli.atom.packed'))} ${cyan(result.artifact)}`);
    out(dim(t('cli.atom.packChecksum', { sha256: result.sha256, file: result.checksumFile })));
    return true;
  }

  return false;
}

export const command: CommandDef = {
  name: 'atom',
  group: 'configure',
  synopsis: 'atom <list|install|update|remove|scaffold|pack> [arg]',
  subcommands: ['list', 'install', 'update', 'remove', 'scaffold', 'pack'],
  description: 'manage Atom Packs (channels, tools, …)',
  descriptionKey: 'cli.cmd.atom.desc',
  flags: {
    out: { type: 'string', description: 'output path for atom-pack.zip', descriptionKey: 'cli.atom.outFlag' }
  },
  localSubcommands: ['scaffold', 'pack'],
  async runLocal(ctx) {
    if (!(await runAuthorCommand(ctx)))
      throw new Error(t('cli.atom.unknownAction', { action: ctx.positionals[0] ?? '' }));
  },
  async run(ctx) {
    if (await runAuthorCommand(ctx)) return;
    const { positionals: args, globals, client } = ctx;
    const [action, ...rest] = args;
    const atoms = client.treaty.v1.atoms;

    switch (action) {
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
        const { atomPacks: list } = requireTreatyData(await atoms.get());
        const targets = rest[0] ? list.filter((p) => p.name === rest[0]) : list.filter((p) => p.canUpdate);
        if (rest[0] && targets.length === 0) throw new Error(t('cli.atom.notFound', { name: rest[0] }));
        for (const p of targets) {
          if (!p.canUpdate) {
            out(yellow(t('cli.atom.noSource', { name: p.name })));
            continue;
          }
          const check = requireTreatyData(await atoms({ name: p.name }).update.get());
          if (!check.hasUpdate) {
            out(dim(t('cli.atom.upToDate', { name: p.name, version: check.currentVersion })));
            continue;
          }
          out(
            t('cli.atom.updateAvailable', { name: p.name, current: check.currentVersion, latest: check.latestVersion })
          );
          if (!globals.yes) {
            out(dim(t('cli.atom.updateConfirmHint', { name: p.name })));
            continue;
          }
          const res = requireTreatyData(
            await atoms({ name: p.name }).update.post({ confirm: true, revision: check.latestRevision })
          );
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
 *  connect()/send(); sessions, rate-limiting and consent are all host-owned. */
function channelScaffold(type: string): Record<string, string> {
  const Type = type.charAt(0).toUpperCase() + type.slice(1);
  return {
    'atom-pack.json': `${JSON.stringify(
      {
        name: `${type}-channel`,
        version: '0.0.1',
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
        files: ['atom-pack.json', 'dist', 'skills', 'mcp.json', 'locales', 'assets'],
        scripts: {
          build: 'bun build ./atom-pack.ts --target=bun --outfile dist/atom-pack.js',
          pack: 'monad atom pack .'
        },
        devDependencies: { '@monad/sdk-atom': 'workspace:*' }
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
  // Declare any credentials the operator must provide (stored beside the atom setting, injected via ctx.secrets).
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
    version: '0.0.1',
    sdkVersion: '0',
    atoms: ['channel'],
    description: '${Type} channel for Monad'
  },
  channels: [${type}ChannelAtom]
});
`,
    'README.md': `# ${Type} channel for Monad

A third-party \`channel\` Atom Pack. The adapter does **platform I/O only** — Monad owns sessions,
group require-mention, rate-limiting and
the conversation→session mapping. Your adapter never sees a sessionId.

## Build and publish

\`\`\`sh
bun run build
git add atom-pack.json dist
git commit -m "build: publish Atom Pack"
git push
\`\`\`

The repository must contain \`atom-pack.json\` and its prebuilt entry. Monad never runs package
installation, build, or lifecycle scripts while installing an Atom Pack.

## Install

\`\`\`sh
monad atom install github:OWNER/REPOSITORY@main
\`\`\`

Then configure a channel instance pointing at \`type: "${type}"\` and set its credential. The first
install surfaces a consent prompt listing the declared atom kinds (\`channel\`).
`
  };
}

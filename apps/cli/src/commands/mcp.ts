import type {
  InstallMcpAtomResponse,
  ListMcpServerStatusResponse,
  McpServerView,
  SearchMcpRegistryResponse
} from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { parseGithubReleaseSource } from '@monad/utils';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';

// Build an McpServerView from CLI args: `mcp add <name> <command> [args…]` (stdio) or
// `mcp add <name> --url <url>` (http, no-auth). Auth/oauth servers belong in `monad config` (system).
function buildServer(rest: string[]): McpServerView | null {
  const name = rest.find((a) => !a.startsWith('-'));
  if (!name) return null;
  const urlIdx = rest.indexOf('--url');
  if (urlIdx !== -1) {
    const url = rest[urlIdx + 1];
    if (!url) return null;
    return { name, transport: 'http', url, auth: { mode: 'none' }, enabled: true, trust: { autoApproveTools: [] } };
  }
  const after = rest.slice(rest.indexOf(name) + 1).filter((a) => a !== '--url');
  const [command, ...args] = after;
  if (!command) return null;
  return { name, transport: 'stdio', command, args, enabled: true, trust: { autoApproveTools: [] } };
}

export const command: CommandDef = {
  name: 'mcp',
  synopsis:
    'mcp <list|status|add|remove|authorize|reconnect> [name] [command…|--url <url>|--release owner/repo@tag --sha256 <hex>]',
  description:
    'manage hot MCP servers (atoms/mcp): add npx/uvx, a remote url, or a prebuilt binary; list; remove; status. ' +
    'authorize/reconnect target system config.json servers (e.g. http+oauth) added via config or the web UI',
  async run({ positionals: args, globals, client }) {
    const [sub, ...rest] = args;
    const mcp = client.treaty.v1.atoms.mcp;

    // Live connection health across EVERY source (config.json + presets + file/pack atoms + obscura),
    // not just the hot atoms `list` shows — mirrors the Studio status dots over the wire.
    if (sub === 'status' || sub === 'st') {
      const { servers } = requireTreatyData<ListMcpServerStatusResponse>(
        await client.treaty.v1.settings['mcp-servers'].status.get()
      );
      json(servers);
      if (servers.length === 0) {
        out(dim(t('cli.mcp.noneConnected')));
        return;
      }
      for (const s of servers) {
        const dot = s.state === 'ready' ? green('●') : s.state === 'failed' ? red('○') : dim('○');
        const meta = dim(`  ${s.source}${s.transport ? `/${s.transport}` : ''}`);
        const tail =
          s.state === 'ready'
            ? dim(`  ${t('cli.mcp.toolCount', { count: s.toolCount })}`)
            : s.state === 'disabled'
              ? dim(`  ${t('cli.disabled')}`)
              : s.state === 'starting'
                ? dim(`  ${t('cli.starting')}`)
                : red(`  ${t('cli.failed')}`);
        out(`${dot} ${cyan(s.name)}${meta}${tail}`);
      }
      return;
    }

    if (sub === 'add' || sub === 'install') {
      const relIdx = rest.indexOf('--release');
      if (relIdx !== -1) {
        // monad mcp add <name> --release owner/repo@tag [--sha256 <hex>] [--bin <exe>]
        // --sha256 is optional: omitted → verify against the release's SHA256SUMS asset.
        const name = rest.find((a) => !a.startsWith('-'));
        const release = rest[relIdx + 1];
        const shaIdx = rest.indexOf('--sha256');
        const sha256 = shaIdx !== -1 ? rest[shaIdx + 1] : undefined;
        const binIdx = rest.indexOf('--bin');
        if (!name || !release) {
          out(dim('usage: monad mcp add <name> --release owner/repo@tag [--sha256 <hex>] [--bin <exe>]'));
          return;
        }
        let source: ReturnType<typeof parseGithubReleaseSource>;
        try {
          source = parseGithubReleaseSource(release);
        } catch {
          out(dim('usage: monad mcp add <name> --release owner/repo@tag [--sha256 <hex>] [--bin <exe>]'));
          return;
        }
        const res = requireTreatyData<InstallMcpAtomResponse>(
          await mcp['install-binary'].post({
            name,
            owner: source.owner,
            repo: source.repo,
            tag: source.tag,
            sha256,
            binName: binIdx !== -1 ? rest[binIdx + 1] : undefined,
            autoApproveTools: [],
            consent: globals.yes === true
          })
        );
        if (res.warnings.length > 0) out(`${yellow(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
        if (res.needsConsent) {
          out(dim(t('cli.atom.consentHint')));
          return;
        }
        out(`${green(t('cli.installed'))} ${cyan(res.name)}`);
        return;
      }

      const server = buildServer(rest);
      if (!server) {
        out(dim('usage: monad mcp add <name> <command> [args…]   |   monad mcp add <name> --url <url>'));
        return;
      }
      const res = requireTreatyData<InstallMcpAtomResponse>(
        await mcp.install.post({ server, consent: globals.yes === true })
      );
      if (res.warnings.length > 0) out(`${yellow(t('cli.atom.scan'))} ${res.warnings.join('; ')}`);
      if (res.needsConsent) {
        out(dim(t('cli.atom.consentHint'))); // re-run with --yes after reviewing
        return;
      }
      out(`${green(t('cli.installed'))} ${cyan(res.name)}`);
      return;
    }

    if (sub === 'remove' || sub === 'rm') {
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) {
        out(dim('usage: monad mcp remove <name>'));
        return;
      }
      requireTreatyData(await mcp({ name }).delete());
      out(`${green(t('cli.removed'))} ${cyan(name)}`);
      return;
    }

    if (sub === 'enable' || sub === 'disable') {
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) {
        out(dim(`usage: monad mcp ${sub} <name>`));
        return;
      }
      requireTreatyData(await mcp({ name })[sub].post());
      out(`${green('✓')} ${cyan(name)} ${dim(sub === 'enable' ? t('cli.enabled') : t('cli.disabled'))}`);
      return;
    }

    // A system config.json server with auth.mode 'oauth' — this blocks on the daemon's interactive
    // flow (loopback opens the daemon-host's browser; device flow logs a code+URL instead) and
    // reconnects the server once tokens are persisted. Same endpoint the web Settings "Authorize"
    // button hits; only reachable for http+oauth servers (config.json), not the hot install/mcp atoms.
    if (sub === 'authorize' || sub === 'auth') {
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) {
        out(dim('usage: monad mcp authorize <name>'));
        return;
      }
      out(dim(t('cli.mcp.authorizing', { name })));
      requireTreatyData(await client.treaty.v1.settings['mcp-servers']({ name }).authorize.post());
      out(`${green('✓')} ${cyan(name)} ${dim(t('cli.mcp.authorized'))}`);
      return;
    }

    if (sub === 'reconnect') {
      const name = rest.find((a) => !a.startsWith('-'));
      if (!name) {
        out(dim('usage: monad mcp reconnect <name>'));
        return;
      }
      requireTreatyData(await client.treaty.v1.settings['mcp-servers']({ name }).reconnect.post());
      out(`${green('✓')} ${cyan(name)} ${dim(t('cli.mcp.reconnected'))}`);
      return;
    }

    if (sub === 'search') {
      const query = rest.join(' ').trim();
      if (!query) {
        out(dim('usage: monad mcp search <query>'));
        return;
      }
      const { entries } = requireTreatyData<SearchMcpRegistryResponse>(
        await client.treaty.v1.settings['mcp-servers'].registry.search.get({ query: { q: query } })
      );
      if (entries.length === 0) {
        out(dim(t('cli.mcp.noneFound', { query })));
        return;
      }
      for (const e of entries) {
        const badge = e.verified ? green('✓') : dim('·');
        out(`  ${badge} ${cyan(e.name)}  ${dim(`[${e.registry}]`)}  ${bold(e.transport)}`);
        out(`    ${e.description}`);
        if (e.command) out(dim(`    ${e.command} ${(e.args ?? []).join(' ')}`));
        if (e.url) out(dim(`    ${e.url}`));
        if (e.env.length > 0) out(dim(`    env: ${e.env.join(', ')}`));
        out('');
      }
      return;
    }

    if (sub && sub !== 'list' && sub !== 'ls') {
      out(dim('usage: monad mcp <list|status|search|add|remove|enable|disable|authorize|reconnect> …'));
      return;
    }

    const { servers } = requireTreatyData(await mcp.get());
    json(servers);
    if (servers.length === 0) {
      out(dim(t('cli.mcp.noneInstalled')));
      return;
    }
    for (const s of servers) {
      out(
        `  ${cyan(s.name)}  ${bold(s.transport)}  ${dim(s.transport === 'stdio' ? (s.command ?? '') : (s.url ?? ''))}`
      );
    }
  }
};

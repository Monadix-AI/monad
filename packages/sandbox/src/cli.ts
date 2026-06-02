#!/usr/bin/env bun

// msr — the monad sandbox runtime CLI. Wraps an arbitrary command in the light OS sandbox (Seatbelt /
// bwrap / Landlock / AppContainer), the same confinement the daemon applies to tool-spawned children,
// but as a standalone process wrapper. No daemon required.
//
//   msr [--writable DIR]… [--read-deny DIR]… [--net none|filtered|unrestricted]
//       [--allow-domain HOST]… [--deny-domain HOST]… [--allow-unconfined] -- CMD [ARG…]
//
// Defaults: the current directory is writable; credential dirs (~/.ssh, ~/.aws, ~/.gnupg,
// ~/.config/gcloud) are read-denied; network is unrestricted. With --net filtered, egress is routed
// through a local filtering proxy that only permits --allow-domain hosts (minus --deny-domain), and
// HTTP(S)_PROXY is injected so the child's curl/pip/npm/git honour it. If no light launcher confines
// this platform, msr refuses to run (exit 3) unless --allow-unconfined is given.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { SandboxManager, SandboxUnavailableError } from './manager.ts';

type NetMode = 'none' | 'filtered' | 'unrestricted';

// Subset of a sandbox.json policy msr honours as a base (CLI flags override).
interface ConfigFileOptions {
  net?: NetMode;
  allowedDomains?: string[];
  deniedDomains?: string[];
  tlsTerminate?: boolean;
}

interface ParsedArgs {
  writable: string[];
  readDeny: string[];
  net?: NetMode;
  allowDomains: string[];
  denyDomains: string[];
  allowUnconfined: boolean;
  tlsTerminate: boolean;
  configPath?: string;
  help: boolean;
  command: string[];
}

const USAGE = `msr — run a command in the monad light OS sandbox

Usage:
  msr [options] -- <command> [args…]
  msr <command> [args…]

Options:
  --writable <dir>       Add a writable root (repeatable). Default: the current directory.
  --read-deny <dir>      Deny reads under <dir> (repeatable). Default: credential dirs.
  --net <mode>           none | filtered | unrestricted (default: unrestricted).
  --allow-domain <host>  With --net filtered, permit this host/subdomain (repeatable).
  --deny-domain <host>   With --net filtered, deny this host/subdomain — wins over allow (repeatable).
  --config <path>        Read a sandbox.json policy (net/domains/tlsTerminate) as the base.
                         CLI flags override it.
  --tls-terminate        With --net filtered, decrypt+inspect HTTPS via an ephemeral MITM CA the
                         child is made to trust (proxy→server TLS still fully verified).
  --allow-unconfined     Run even if no launcher can confine this platform (DANGEROUS).
  -h, --help             Show this help.
`;

function credentialDenyDefaults(): string[] {
  const home = homedir();
  return [join(home, '.ssh'), join(home, '.aws'), join(home, '.gnupg'), join(home, '.config', 'gcloud')];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    writable: [],
    readDeny: [],
    allowDomains: [],
    denyDomains: [],
    allowUnconfined: false,
    tlsTerminate: false,
    help: false,
    command: []
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-h' || a === '--help') {
      out.help = true;
      return out;
    }
    if (a === '--allow-unconfined') {
      out.allowUnconfined = true;
      continue;
    }
    if (a === '--tls-terminate') {
      out.tlsTerminate = true;
      continue;
    }
    if (a === '--config') {
      const v = argv[++i];
      if (v) out.configPath = resolve(v);
      continue;
    }
    if (a === '--writable') {
      const v = argv[++i];
      if (v) out.writable.push(resolve(v));
      continue;
    }
    if (a === '--read-deny') {
      const v = argv[++i];
      if (v) out.readDeny.push(resolve(v));
      continue;
    }
    if (a === '--allow-domain') {
      const v = argv[++i];
      if (v) out.allowDomains.push(v);
      continue;
    }
    if (a === '--deny-domain') {
      const v = argv[++i];
      if (v) out.denyDomains.push(v);
      continue;
    }
    if (a === '--net') {
      const v = argv[++i];
      if (v !== 'none' && v !== 'filtered' && v !== 'unrestricted') {
        process.stderr.write(`msr: --net must be "none", "filtered", or "unrestricted", got "${v}"\n`);
        process.exit(2);
      }
      out.net = v;
      continue;
    }
    if (a?.startsWith('-')) {
      process.stderr.write(`msr: unknown option "${a}"\n${USAGE}`);
      process.exit(2);
    }
    // First non-flag token: the rest is the command.
    break;
  }
  out.command = argv.slice(i);
  return out;
}

const warn = (m: string): void => {
  process.stderr.write(`msr: ${m}\n`);
};

// Read a sandbox.json policy loosely (this is a CLI convenience, not the daemon's validated load).
// Only the fields msr acts on are mapped; unknown/invalid ones are ignored.
function loadSandboxConfigFile(path: string): ConfigFileOptions {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    warn(`cannot read --config ${path}: ${(err as Error).message}`);
    process.exit(2);
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const out: ConfigFileOptions = {};
  if (c.net === 'none' || c.net === 'filtered' || c.net === 'unrestricted') out.net = c.net;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (Array.isArray(c.allowedDomains)) out.allowedDomains = strings(c.allowedDomains);
  if (Array.isArray(c.deniedDomains)) out.deniedDomains = strings(c.deniedDomains);
  if (
    c.tlsTerminate &&
    typeof c.tlsTerminate === 'object' &&
    (c.tlsTerminate as { enabled?: unknown }).enabled === true
  ) {
    out.tlsTerminate = true;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.command.length === 0) {
    process.stderr.write(`msr: no command given\n${USAGE}`);
    process.exit(2);
  }

  // sandbox.json is the base; a CLI flag overrides its field when the flag is present.
  const cfg = args.configPath ? loadSandboxConfigFile(args.configPath) : {};

  let mgr: SandboxManager;
  try {
    mgr = new SandboxManager({
      writableRoots: args.writable.length > 0 ? args.writable : undefined,
      readDenyRoots: args.readDeny.length > 0 ? args.readDeny : credentialDenyDefaults(),
      net: args.net ?? cfg.net,
      allowedDomains: args.allowDomains.length > 0 ? args.allowDomains : cfg.allowedDomains,
      deniedDomains: args.denyDomains.length > 0 ? args.denyDomains : cfg.deniedDomains,
      tlsTerminate: args.tlsTerminate || (cfg.tlsTerminate ?? false),
      allowUnconfined: args.allowUnconfined,
      log: (m) => process.stderr.write(`msr: ${m}\n`)
    });
  } catch (err) {
    if (err instanceof SandboxUnavailableError) {
      process.stderr.write(`${err.message}\nRe-run with --allow-unconfined to run anyway (DANGEROUS).\n`);
      process.exit(3);
    }
    throw err;
  }

  process.on('exit', () => mgr.dispose());
  const child = mgr.spawn(args.command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  void child.exited.then((code) => process.exit(code));
}

main();

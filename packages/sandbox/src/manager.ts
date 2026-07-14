// SandboxManager — the programmatic facade over the light OS sandbox (à la srt's SandboxManager).
// Given a policy (writable/read-deny roots, net mode, egress allow/deny, optional TLS-MITM +
// credential sentinels), it selects the platform launcher, stands up the filtering proxy/MITM/sentinel
// machinery, and hands back a wrap()/spawn() + the child env to inject. The daemon does NOT use this —
// it wires the same primitives through its own global seams for session lifecycle/hot-reload; this is
// for standalone consumers (the `msr` CLI, external callers) that want one object to confine a process.

import type { SandboxLauncher, SandboxPolicy } from '@monad/sdk-atom';

import { tmpdir } from 'node:os';

import { MaskedFileStore } from './credential-mask-files.ts';
import { type CredentialTransform, materializeCredential } from './credential-materializer.ts';
import { SentinelRegistry } from './credential-sentinel.ts';
import { type EgressProxy, startEgressProxy } from './egress-proxy.ts';
import { createMitmCA, disposeMitmCA, type MitmCA } from './mitm/ca.ts';
import { caTrustEnv } from './mitm/trust-env.ts';
import { selectSandboxLauncher } from './registry.ts';

export interface SandboxManagerCredential {
  name: string;
  value: string;
  injectHosts: string[];
  transform?: CredentialTransform;
}
export interface SandboxManagerCredentialFile {
  name: string;
  path: string;
  injectHosts: string[];
  extract?: string;
  transform?: CredentialTransform;
}

export interface SandboxManagerOptions {
  /** Paths the child may write. Default: the current directory. `tmpdir()` is always added. */
  writableRoots?: string[];
  /** Base read-deny set. Un-maskable credential files are appended (fail-closed). */
  readDenyRoots?: string[];
  /** 'none' | 'filtered' (proxy-gated egress) | 'unrestricted' (default). */
  net?: 'none' | 'filtered' | 'unrestricted';
  /** Egress allowlist / denylist for net:'filtered' (denylist wins). */
  allowedDomains?: string[];
  deniedDomains?: string[];
  /** Decrypt+inspect HTTPS via an ephemeral MITM CA the child is made to trust. Needs net:'filtered'. */
  tlsTerminate?: boolean;
  /** Env-based credentials: child sees a sentinel; proxy swaps to real on egress to injectHosts. */
  credentials?: SandboxManagerCredential[];
  /** File-based credentials (masked file / degrade-to-deny). Both credential kinds need tlsTerminate. */
  credentialFiles?: SandboxManagerCredentialFile[];
  /** Run the command unconfined when no launcher can confine this platform (default: throw). */
  allowUnconfined?: boolean;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
}

export class SandboxUnavailableError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`@monad/sandbox: no launcher can confine ${platform}; pass allowUnconfined:true to run without confinement.`);
    this.name = 'SandboxUnavailableError';
  }
}

export class SandboxManager {
  /** The selected light launcher (`noneLauncher` when unconfined). */
  readonly launcher: SandboxLauncher;
  /** False when no launcher confines this platform and `allowUnconfined` let it run raw. */
  readonly confined: boolean;

  private readonly env: Record<string, string>;
  private readonly policy: SandboxPolicy;
  private readonly proxy?: EgressProxy;
  private readonly mitm?: MitmCA;
  private readonly store?: MaskedFileStore;
  private disposed = false;

  constructor(opts: SandboxManagerOptions = {}) {
    const log = opts.log ?? (() => {});
    const platform = opts.platform ?? process.platform;
    const netMode = opts.net ?? 'unrestricted';

    this.launcher = selectSandboxLauncher(platform, 'auto');
    this.confined = this.launcher.kind !== 'none' && typeof this.launcher.wrap === 'function';
    if (!this.confined && !opts.allowUnconfined) throw new SandboxUnavailableError(platform);

    let net: SandboxPolicy['net'] = netMode === 'filtered' ? undefined : netMode;
    let env: Record<string, string> = {};
    let maskedBinds: { real: string; fake: string }[] = [];
    let maskedDeny: string[] = [];
    const creds = opts.credentials ?? [];
    const credFiles = opts.credentialFiles ?? [];

    if (netMode === 'filtered') {
      // MITM lets the proxy see decrypted HTTPS headers — required for credential-sentinel substitution.
      const mitm = opts.tlsTerminate ? createMitmCA() : undefined;
      this.mitm = mitm;

      let sentinels: SentinelRegistry | undefined;
      let sentinelEnv: Record<string, string> = {};
      if (creds.length > 0 || credFiles.length > 0) {
        if (!mitm) {
          log('credentials require tlsTerminate (the proxy cannot see HTTPS headers otherwise) — ignoring.');
        } else {
          const registry = new SentinelRegistry();
          for (const c of creds) {
            const materialized = materializeCredential(c.value, c.injectHosts, c.transform);
            if (!materialized.ok) {
              log(`credential "${c.name}" failed: ${materialized.error} — omitting child environment variable.`);
              continue;
            }
            registry.registerMaterialized(c.name, materialized.value.childValue, materialized.value.substitutions);
          }
          if (credFiles.length > 0) {
            const store = new MaskedFileStore();
            this.store = store;
            for (const f of credFiles) {
              store.add(registry, {
                name: f.name,
                realPath: f.path,
                injectHosts: f.injectHosts,
                extract: f.extract,
                transform: f.transform
              });
            }
            maskedBinds = [...store.list];
            maskedDeny = [...store.denyPaths]; // fail-closed: un-maskable files denied, not left readable
          }
          sentinels = registry;
          sentinelEnv = registry.childEnv();
        }
      }

      const proxy = startEgressProxy({
        policy: { allowedDomains: opts.allowedDomains ?? [], deniedDomains: opts.deniedDomains ?? [] },
        mitm,
        rewriteRequest: sentinels ? (host, block) => sentinels.substitute(host, block) : undefined,
        rewriteBody: sentinels ? (host, body) => sentinels.substitute(host, body) : undefined,
        log
      });
      this.proxy = proxy;
      net = { allowProxyPort: proxy.port };
      // SOCKS5 shares the muxed port; socks5h = proxy-side DNS so the child's hostname hits the allowlist.
      const socksUrl = `socks5h://127.0.0.1:${proxy.port}`;
      env = {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        http_proxy: proxy.url,
        https_proxy: proxy.url,
        ALL_PROXY: socksUrl,
        all_proxy: socksUrl,
        ...(mitm ? caTrustEnv(mitm.caCertPath) : {}),
        ...sentinelEnv
      };
    } else if (opts.tlsTerminate) {
      log('tlsTerminate requires net:filtered — ignoring.');
    } else if (creds.length > 0 || credFiles.length > 0) {
      log('credentials require net:filtered + tlsTerminate — ignoring.');
    }

    this.env = env;
    const writable = opts.writableRoots?.length ? opts.writableRoots : [process.cwd()];
    this.policy = {
      writableRoots: [...writable, tmpdir()],
      readDenyRoots: [...(opts.readDenyRoots ?? []), ...maskedDeny],
      maskedFiles: maskedBinds.length > 0 ? maskedBinds : undefined,
      net
    };
  }

  /** Env to inject into the child (proxy + CA-trust + sentinel vars). Empty unless net:'filtered'. */
  get childEnv(): Record<string, string> {
    return { ...this.env };
  }

  get sandboxPolicy(): SandboxPolicy {
    return this.policy;
  }

  /** `argv` wrapped by the selected launcher, or the raw argv when running unconfined. */
  wrap(argv: string[]): string[] {
    return this.confined && this.launcher.wrap ? this.launcher.wrap(argv, this.policy) : argv;
  }

  /** Spawn the command confined, merging `childEnv` over the current process env. Caller sets stdio. */
  spawn(argv: string[], options: Parameters<typeof Bun.spawn>[1] = {}): Bun.Subprocess {
    const merged =
      Object.keys(this.env).length > 0 ? { ...(process.env as Record<string, string>), ...this.env } : undefined;
    return Bun.spawn(this.wrap(argv), merged ? { env: merged, ...options } : options);
  }

  /** Stop the proxy and dispose the MITM CA + masked-file store. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.proxy?.stop();
    if (this.mitm) void disposeMitmCA(this.mitm);
    this.store?.dispose();
  }
}

// SandboxManager — the programmatic facade over the light OS sandbox.
// Given a policy (writable/read-deny roots, net mode, egress allow/deny, optional TLS-MITM +
// optional TLS termination), it selects the platform launcher and stands up the filtering proxy/MITM
// machinery, and hands back a wrap()/spawn() + the child env to inject. The daemon does NOT use this —
// it wires the same primitives through its own global seams for session lifecycle/hot-reload; this is
// for standalone consumers (the `msr` CLI, external callers) that want one object to confine a process.

import type { SandboxLauncher, SandboxPolicy } from '@monad/sdk-atom';

import { tmpdir } from 'node:os';

import { type EgressProxy, startEgressProxy } from './egress-proxy.ts';
import { createMitmCA, disposeMitmCA, type MitmCA } from './mitm/ca.ts';
import { caTrustEnv } from './mitm/trust-env.ts';
import { selectSandboxLauncher } from './registry.ts';

export interface SandboxManagerOptions {
  /** Paths the child may write. Default: the current directory. `tmpdir()` is always added. */
  writableRoots?: string[];
  /** Paths the child may not read. */
  readDenyRoots?: string[];
  /** 'none' | 'filtered' (proxy-gated egress) | 'unrestricted' (default). */
  net?: 'none' | 'filtered' | 'unrestricted';
  /** Egress allowlist / denylist for net:'filtered' (denylist wins). */
  allowedDomains?: string[];
  deniedDomains?: string[];
  /** Decrypt+inspect HTTPS via an ephemeral MITM CA the child is made to trust. Needs net:'filtered'. */
  tlsTerminate?: boolean;
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
    if (netMode === 'filtered') {
      const mitm = opts.tlsTerminate ? createMitmCA() : undefined;
      this.mitm = mitm;

      const proxy = startEgressProxy({
        policy: { allowedDomains: opts.allowedDomains ?? [], deniedDomains: opts.deniedDomains ?? [] },
        mitm,
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
        ...(mitm ? caTrustEnv(mitm.caCertPath) : {})
      };
    } else if (opts.tlsTerminate) {
      log('tlsTerminate requires net:filtered — ignoring.');
    }

    this.env = env;
    const writable = opts.writableRoots?.length ? opts.writableRoots : [process.cwd()];
    this.policy = {
      writableRoots: [...writable, tmpdir()],
      readDenyRoots: [...(opts.readDenyRoots ?? [])],
      net
    };
  }

  /** Env to inject into the child (proxy + CA trust). Empty unless net:'filtered'. */
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

  /** Stop the proxy and dispose the MITM CA. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.proxy?.stop();
    if (this.mitm) void disposeMitmCA(this.mitm);
  }
}

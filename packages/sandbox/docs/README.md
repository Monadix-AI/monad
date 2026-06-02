# `@monad/sandbox` docs

Shared sandbox policy layer: launcher selection, filesystem confinement, the muxed
HTTP/SOCKS5 egress proxy, optional TLS termination, and Agent Credential protected
execution. Consumed by the daemon and the standalone `msr` CLI.

| Doc | Covers |
|---|---|
| [hardening.md](hardening.md) | Per-platform confinement status (Seatbelt, bwrap/Landlock/seccomp, AppContainer), egress filtering, and known gaps |

Related: [`docs/internal/development/security-guidelines.md`](../../../docs/internal/development/security-guidelines.md)
for the repo-wide rules, [`packages/sandbox-vm/docs/`](../../sandbox-vm/docs/) for the VM backend.

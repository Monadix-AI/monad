# `@monad/sandbox-vm` docs

VM-backed sandbox enforcement: guest boundary, shares and overlays, per-run namespaces,
cgroups, vsock execution, guest firewall rules. Policy (domains, credentials, TLS
termination) stays in [`@monad/sandbox`](../../sandbox).

| Doc | Covers |
|---|---|
| [conformance.md](conformance.md) | What counts as confinement evidence, the evidence matrix, and how to produce a real-VM result |
| [supply-chain.md](supply-chain.md) | Where the vendored guest/host binaries come from, how they are pinned and verified, and how to rebuild them |

Related: [`packages/sandbox/docs/hardening.md`](../../sandbox/docs/hardening.md) for the
light OS launchers, [`docs/usage/sandbox-backends.md`](../../../docs/usage/sandbox-backends.md)
for the user-facing backend settings.

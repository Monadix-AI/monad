# Sandbox VM P5 SRT Closure Design

## Goal

Close the remaining actionable gap between Monad's VM sandbox and Anthropic Sandbox Runtime after P0-P4 and the security diff fixes. This batch documents the layer boundary, adds missing adversarial real-VM coverage, and makes every comparison claim evidence-scoped.

## Boundary

`@monad/sandbox-vm` is an isolation backend, not a second policy engine. It must:

- isolate workloads behind a guest kernel and per-run namespaces;
- expose only declared shares and install every deny/mask overlay for every guest alias;
- attach no NIC for `net:'none'`;
- for filtered networking, permit only DHCP and TCP to the host egress proxy;
- treat seccomp pathname events as bounded best-effort telemetry, never enforcement evidence.

`@monad/sandbox` remains the policy layer. It owns domain allow/deny decisions, DNS rebinding checks, HTTP and SOCKS mediation, optional TLS termination, structured credential materialization, and destination-bound credential restoration. Duplicating those decisions inside the VM would create two policy sources that can drift.

The standalone SRT CLI, settings-file format, macOS Apple Events/Unix-socket compatibility switches, and native-host sandbox backends are not VM-backend requirements. Monad already exposes policy and backend selection through its daemon, CLI, and shared launcher contracts.

## Added Evidence

The common real-VM suite will prove that overlapping canonical shares cannot re-expose a deny or credential mask through a symlinked guest alias. The filtered-network suite will prove that both public DNS and gvproxy's built-in resolver are unreachable directly while the only permitted non-DHCP destination is the configured host proxy.

Special credential sources remain a policy-layer test: a FIFO or other non-regular file must be converted into a canonical read deny before a VM policy is built. A VM must never be asked to read or materialize that source.

## Comparison Contract

A checked-in matrix will distinguish:

- supported at the shared policy layer;
- enforced by the VM backend;
- intentionally not applicable to a VM backend;
- covered but not executed on a real hypervisor for the current checkout.

The matrix must not use "stronger" as an unqualified global claim. VM isolation is structurally stronger for kernel, process, host IPC, and network-device separation; SRT remains a more complete standalone compatibility surface.

## Verification

Focused Bun tests cover mount aliases, filtered firewall output, special credential files, workflow discovery, and documentation invariants. Go tests cover vsock peer authorization and observation normalization. Real-VM tests remain gated by `MONAD_VM_IT=1`; skipped discovery is coverage only.

# Sandbox VM and SRT parity

This matrix compares Monad with Anthropic Sandbox Runtime (SRT) at commit `cf24a43eba92c9ab4140c380d11ca55771be9db2` (2026-07-13). It compares the complete Monad sandbox stack, then identifies which guarantees belong specifically to the VM backend.

## Layer contract

The `@monad/sandbox` policy layer owns destination and credential decisions: domain allow/deny and DNS rebinding checks, HTTP and SOCKS mediation, optional TLS termination, structured credential materialization, and destination-bound restoration.

The `@monad/sandbox-vm` enforcement layer owns the guest boundary: VM lifecycle, shares and overlays, per-run process and mount namespaces, cgroups, vsock execution, and guest firewall rules. Filtered guest can reach only DHCP and the host proxy. It cannot resolve or dial arbitrary destinations directly.

Keeping these layers separate gives every backend one policy source. Moving domain or credential decisions into the VM would duplicate `@monad/sandbox` and create policy drift.

## Feature matrix

| Capability | SRT | Monad | State |
| --- | --- | --- | --- |
| Programmatic manager | `SandboxManager` | `@monad/sandbox` `SandboxManager` | Equivalent shared-policy surface |
| Command-line entry point | `srt` settings-driven CLI | `msr` shared-policy CLI and `msvm` VM debug CLI | Available; command/config shapes intentionally differ |
| macOS host sandbox | Seatbelt | Seatbelt | Shared-policy backend, not VM-specific |
| Linux host sandbox | bubblewrap | bubblewrap, Landlock fallback | Shared-policy backend, not VM-specific |
| Windows host sandbox | dedicated user, WFP, ACL | AppContainer; VM option uses Hyper-V | Monad VM provides a stronger kernel boundary when selected |
| Filesystem allow/write/deny | native mount or OS rules | canonical VM shares followed by deny overlays | VM enforced |
| Credential-file masking | fake read-only file | shared materializer plus read-only VM mask overlay | VM enforced after policy materialization |
| Structured credentials and JWT claim masking | supported | supported in `@monad/sandbox` | Shared policy |
| Domain allow/deny and DNS rebinding checks | proxy | host egress proxy | Shared policy |
| HTTP CONNECT and forward proxy | supported | supported | Shared policy |
| SOCKS mediation with proxy-side DNS | supported | SOCKS5H on the same bounded proxy | Shared policy |
| TLS termination and credential restoration | supported | supported and destination-bound | Shared policy |
| Filter bypass resistance | network namespace and proxy sockets | guest nftables permits only DHCP and host proxy | VM enforced |
| `net:none` | isolated network namespace | no VM NIC, plus drop policy | VM enforced with stronger device separation |
| PTY | supported | guest-native PTY over vsock | VM enforced |
| Resource ceilings | process supervision | cgroup memory and PID ceilings | VM enforced |
| Host Unix-socket controls | explicit compatibility switches | host sockets absent unless explicitly shared | Not a VM compatibility requirement |
| macOS Apple Events | explicit compatibility switch | unavailable across the VM boundary | Not applicable to VM workloads |
| Baseline restore | not a primary SRT feature | QEMU/KVM and Hyper-V pre-workload baselines | Monad VM extension |
| Filesystem syscall diagnostics | passive seccomp notification | bounded passive seccomp notification | Diagnostic parity; best-effort telemetry only |

## Security comparison

The VM backend is structurally stronger for guest-kernel compromise containment, process-table isolation, host IPC separation, and network-device separation. In `net:none`, there is no guest NIC. On Windows, Hyper-V avoids relying solely on a dedicated host user, WFP, and host ACL mutation.

This is not a global claim that Monad is stronger in every configuration. SRT has a mature standalone compatibility surface, while Monad can also select lighter native backends whose guarantees depend on the host OS. The VM guarantee applies only when the built-in `vm` backend is selected and successfully admitted.

Seccomp pathname observations are not enforcement evidence. The observed process can race its pathname memory around `SECCOMP_USER_NOTIF_FLAG_CONTINUE`; Monad samples twice and canonicalizes symlinks, but still treats the result as best-effort telemetry. Shares, read-only mounts, overlays, nftables, cgroups, and host-side oracles are the security boundary.

## Evidence status

- Focused TypeScript, Go, and cross-compile gates: run for the current working tree.
- Real-VM coverage: checked in for QEMU/KVM, vfkit, and Hyper-V.
- Real-VM evidence: not run for this checkout unless an exact self-hosted workflow result is recorded in a release artifact.

See [Sandbox VM conformance](sandbox-vm-conformance.md) for the evidence vocabulary and runner requirements.

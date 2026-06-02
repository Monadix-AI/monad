# Sandbox confinement — hardening status

What OS-level confinement `@monad/sandbox` has shipped, and what gaps remain. Update this
file when a hardening item lands or is deliberately deferred; the top-level rule that points
here is [security-guidelines.md § 8](../../../docs/internal/development/security-guidelines.md).

## Implemented

**macOS — Seatbelt (`sandbox-exec`)**
- FS writes restricted to declared `writableRoots` via SBPL profile generated at spawn time.
- `readDenyRoots` adds last-match-wins deny rules to block reads of credential directories
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, credentials store) even under open egress.
- `net: 'none'` denies all outbound connections at the kernel level.
- `net: { allowProxyPort }` permits only the local filtering proxy; all other sockets denied.
- `net: 'unrestricted'` leaves egress fully open (default for development convenience).
- Tests: `apps/monad/test/unit/tools/seatbelt.macos.test.ts` (live kernel, 7 cases).

**Linux — bwrap (preferred, when installed) + Landlock + seccomp-bpf** (`packages/sandbox/src/launchers/bwrap.ts`, `apps/monad/native/sandbox-launcher/main.c`)

bwrap launcher — auto-selected when `bwrap` is on PATH:
- Uses bubblewrap's mount namespace to build an isolated FS view from scratch.
- `readDenyRoots` enforced in two ways: (1) confined mode (`writableRoots` set) — credential dirs are simply never bound, so they're absent in the child's namespace; (2) unrestricted-write mode — `--tmpfs` is overlaid over each deny path, making it an empty, inaccessible mount.
- `net:'none'` via `--unshare-net` (kernel network namespace, no IP sockets for child).
- `--die-with-parent` + `--unshare-pid` prevent orphaned processes and `/proc` leaks.

Landlock + seccomp-bpf launcher — fallback when `bwrap` is absent:
- Landlock FS ruleset: write-access rights only (`WRITE_V1`–`WRITE_V3` per kernel ABI),
  applied to each `writableRoot`. Reads remain unrestricted. ABI version auto-detected.
  **`readDenyRoots` is NOT enforced in this path** — Landlock is an additive read *allowlist* and
  can't express "deny `~/.ssh`, allow everything else"; the launcher deliberately doesn't forward
  it (would require a deny-default mount namespace). Credential read-deny requires bwrap (see Known gaps).
- seccomp-bpf filter (after Landlock): `SECCOMP_RET_ERRNO | EPERM` on:
  - `ptrace` — prevents same-UID process injection
  - `process_vm_writev` — cross-process memory write (ptrace-equivalent without CAP)
  - `open_by_handle_at` — can escape Landlock via a stale fd leaked from an ancestor
- **`net:'none'` is enforced in-kernel**: with `--net none` the seccomp filter also returns
  `SECCOMP_RET_ERRNO | EACCES` on `socket(AF_INET|AF_INET6, …)`, so the child cannot open *any* IP
  socket — a raw socket can't bypass `HTTP(S)_PROXY`. `AF_UNIX` stays allowed (local IPC).
  `net:'filtered'`/`'unrestricted'` do not set this (filtered needs the proxy reachable; seccomp
  can't allow-by-IP). `socket()`'s domain is `args[0]`, a scalar seccomp can inspect directly.
- `PR_SET_NO_NEW_PRIVS` set unconditionally so both layers work independently.
- Graceful degradation: Landlock unavailable (kernel < 5.13) → unconfined with warning;
  seccomp `EINVAL`/`ENOSYS` → silently skipped; `socketcall`-only arches (i386, no `SYS_socket`)
  skip the socket block.
- Tests: `apps/monad/test/unit/tools/sandbox-escape.linux.test.ts` (12 cases, incl. net:'none' AF_INET/
  AF_INET6 block + default-net allow). The complete sandbox package, daemon tool, and bwrap E2E scope
  is documented in [Sandbox VM conformance](../../sandbox-vm/docs/conformance.md). Verified live on Ubuntu
  26.04 arm64 with kernel 7.0 under UTM; that native-sandbox result does not imply nested KVM
  availability.

**Windows — AppContainer (preferred) + Low Integrity fallback** (`apps/monad/native/sandbox-launcher/windows-appcontainer.c`, `windows.c`)

AppContainer launcher (`monad-sandbox-appcontainer.exe`) — selected when present:
- Child launched via `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
  into a named AppContainer profile (`monad.<sessionId>`).
- Writable roots granted `GENERIC_ALL` for the AppContainer SID before launch.
- Credential dirs (`~/.ssh`, `~/.aws`, `~/.gnupg`, etc.) get an explicit `DENY_ACCESS` ACE for
  the AppContainer SID — **closes the credential read-deny gap** that Low IL cannot address.
- Grant/deny ACEs are **scoped to the child's lifetime**: the launcher reverts every ACE it set
  after the child exits, on both the normal and the CreateProcessW-fallback path, so a run never
  leaves the host's DACLs mutated. The revert edits the DACL directly (`GetAce`+`DeleteAce` on
  matching SID) — `SetEntriesInAcl(REVOKE_ACCESS)` removes only ALLOW ACEs and would leak the
  deny-read ACE. Reverting the inheritable ACE on a directory also clears the copies inherited
  onto its children, so no orphaned-SID ACE survives.
- `net:'none'` enforced by omitting all network capability SIDs: the child has no IP sockets.
- `net:'filtered'`/`'unrestricted'` grant `INTERNET_CLIENT + INTERNET_CLIENT_SERVER + LOCAL_LOOP`
  capabilities; domain filtering relies on the egress proxy (app-layer, same as Linux filtered).
- Profile lifecycle: per-session profiles created lazily, cleaned up via `disposeSession()`.
  Orphan sweep enumerates `%LOCALAPPDATA%\Packages\monad.*` (the folder name is the moniker) and
  calls `DeleteAppContainerProfile` on each — the `AppContainer\Mappings` registry key is absent
  on modern Windows (verified Win11 26200), so registry enumeration is not used.
  Falls back to unconfined `CreateProcessW` when `CreateAppContainerProfile` is unavailable
  (pre-Win8 or restricted CI environments) so old environments stay functional.
- Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` in both launchers.
- Compiles with `_WIN32_WINNT 0x0A00` set in-source so userenv.h declares the AppContainer APIs;
  without it clang (the arm64 llvm-mingw build) errors and gcc silently builds wrong implicit stubs.
- **Validated live on Windows 11 ARM64 (build 26200)** via `packages/sandbox/test/smoke/appcontainer-win32.ts`
  (write-grant, write-deny outside root, credential read-deny, orphan sweep, ACE revert all pass).
  The launcher must be the host's native architecture — an x64-emulated launcher cannot start
  AppContainer children (`STATUS_DLL_INIT_FAILED`).
- The complete local spawn seam is covered by
  `packages/sandbox/test/smoke/appcontainer-spawn-win32.ts`: automatic launcher selection, policy
  construction, confinement, cancellation, and per-session profile disposal. AppContainer launchers
  run attached on Windows because Bun's detached process mode prevents their child from initializing.

Low Integrity launcher (`monad-sandbox-launcher.exe`) — fallback when AppContainer binary absent:
- Child launched under a Low IL token (`S-1-16-4096`) via `DuplicateTokenEx` + `SetTokenInformation`.
- Prevents writes to Medium/High integrity objects. Does NOT enforce readDeny or net isolation.
- A Windows 11 ARM64 UTM run on 2026-08-06 confirmed automatic fallback selection and the Low IL
  token, but writable-root confinement did not pass: adding a Low IL SID DACL does not lower the
  target's mandatory integrity label. This fallback is therefore not claimed as live-conformant;
  AppContainer remains the validated Windows backend.

**Egress filtering (all platforms)** — the sandbox package is `@monad/sandbox` (extracted from the
daemon; the daemon and the standalone `msr` CLI both consume it).
- `@monad/sandbox/src/egress-proxy.ts`: raw-TCP local proxy on `127.0.0.1:0` (port auto-assigned). One
  **muxed** port: the first connection byte selects the handler — `CONNECT`/HTTP forward (HTTP) or
  **SOCKS5** (`0x05`), so non-HTTP TCP (SSH/DB/git-ssh) is gated too via `ALL_PROXY=socks5h://…`.
- Domain allow/deny: `isEgressAllowed(host, policy)` in `egress-policy.ts` — `allowedDomains` plus
  `deniedDomains` (deny wins, even over `'*'`); subdomain matching; loopback/private/link-local always
  blocked (SSRF guard). SOCKS5 CONNECT runs the SAME gate before any upstream connect.
- DNS rebinding protection: all resolved addresses re-checked with `isBlockedIp`.
- When `net: 'filtered'`, the proxy port is the only allowed egress; `HTTP(S)_PROXY` + `ALL_PROXY` env
  injected into the child so `curl`/`pip`/`npm`/`git` route through it transparently.
- **TLS-terminating MITM (opt-in, `tlsTerminate.enabled`)** — `@monad/sandbox/src/mitm/`: an
  **ephemeral** RSA-2048 CA (temp dir, key `0o600`, disposed on exit; or an operator-supplied
  `caCertPath`/`caKeyPath`) mints per-host leaf certs; the proxy terminates the child's HTTPS (child
  trusts the CA via injected `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/… — child-scoped, never the host
  store) and re-issues upstream with **real cert validation** (`rejectUnauthorized` left default). This
  is what earlier docs listed as out-of-scope; it is now shipped, opt-in, and gated behind
  `net:'filtered'`. Off → HTTPS stays an opaque `CONNECT` tunnel (unchanged).
- **Agent Credential protected execution (requires MITM)** — each Code Act, `shell_exec`, or background
  process resolves a fresh immutable copy of the credentials granted to that agent. The confined child
  receives only a per-execution `fake_value_<uuid>` environment value; the real secret stays in the
  per-execution proxy registry and is swapped onto the proxy→server leg only for that credential's
  allowed hosts. Substitution covers request **headers and a bounded (≤1 MB, non-chunked, UTF-8) request
  body**. Chunked, oversized, or binary bodies pass through with the sentinel unchanged. Protected
  execution fails closed before child launch when TLS termination, a local launcher with enforced
  filtered networking, or proxy startup is unavailable. Host execution, delegated terminals, remote
  launchers, and container backends do not receive Agent Credentials. Native Monad integrations keep
  their credentials in their own settings and do not use this mechanism. The canonical Agent
  Credential vault policy denies both the exact `auth.json` file and the Credentials directory in
  daemon filesystem operations and every local child policy. While that vault contains a secret,
  **all** agent-generated local execution, including agents with zero grants, requires a launcher
  that enforces the read deny. Background processes are owned by both session and agent; rebinding a
  session terminates its old processes and waits for protected-proxy teardown before committing the
  new agent.
- **Enforcement tier differs by net mode + platform.** `net:'none'` is OS-enforced on macOS
  (Seatbelt `deny network*`) **and Linux** (seccomp `socket(AF_INET/6)` block); on Windows it is
  advisory. `net:'filtered'` is **application-layer on every platform** — the proxy + `HTTP(S)_PROXY`/
  `ALL_PROXY` env. A child that opens a raw socket instead of honouring the proxy env bypasses *filtered*
  on Linux/Windows (macOS Seatbelt still confines it to the proxy port). See Known gaps.

**Opt-in heavy backends** — the light OS launchers (Seatbelt/bwrap/Landlock/AppContainer) are a
**closed built-in set** in `@monad/sandbox` and the always-on default. The **heavy** backends
(docker/e2b/vm) are **not** in the built-in atom pack: they live in `@monad/monad-power-pack` and are
used only when the pack is enabled AND `agent.sandbox.backend` names one — otherwise selection stays on
the light default (a named-but-unavailable heavy backend falls back to light with a warning). Installing
the pack registers its launchers through the same release artifact, consent, and atom-kind gates as
any third-party pack.

**Violation monitoring (macOS)** — `@monad/sandbox/src/violation-monitor.ts`: `startViolationMonitor`
tails Seatbelt deny events (`log stream`) and parses each into `{ operation, target, process }` for
debugging a too-tight policy. Opt-in (nothing spawned unless started); a no-op off macOS.

## Known gaps / pending

| Gap | Severity | Notes |
|---|---|---|
| **Linux: `net:'filtered'` is app-layer (raw-socket bypass)** | Medium | `net:'none'` is kernel-enforced on Linux (seccomp blocks `socket(AF_INET/6)`), so a no-egress sandbox is real. But `net:'filtered'` (HTTP proxy AND the muxed SOCKS5 path) relies on the application-layer proxy + `HTTP(S)_PROXY`/`ALL_PROXY` env: seccomp can't allow-by-destination-IP, so a child that opens a raw socket instead of honouring the proxy env bypasses the domain allowlist. True per-destination filtering requires a network namespace (`unshare --net` + veth/nft, needs `bubblewrap` or unprivileged userns). Deferred — `net:'none'` covers the "no exfil at all" case; filtered covers the cooperative-tooling case (package managers / curl). |
| **Windows: `net:'filtered'` is app-layer** | Low | AppContainer `net:'none'` removes all network capabilities — enforced. `net:'filtered'` still grants `INTERNET_CLIENT` capabilities and relies on the egress proxy; a raw socket can bypass the domain allowlist. WFP filters would close this. Deferred. |
| **Linux: credential read-deny enforced only when bwrap is installed** | Low | When `bwrap` is on PATH, `bwrapLauncher` is auto-selected and enforces readDeny: confined mode simply never binds credential dirs; unrestricted-write mode overlays `--tmpfs` over each deny path. When `bwrap` is absent (minimal containers, Alpine) `landlockLauncher` takes over; Landlock is an additive read-allowlist and cannot express deny. Daemon filesystem tools still deny the canonical Agent Credential vault, and while that vault contains a secret every agent-generated local shell or Code Act launch fails before spawn instead of degrading to a process that could read it. |
| **macOS: seccomp equivalent missing** | Low | Seatbelt's `(deny process*)` can prevent fork/exec but there is no fine-grained syscall filter equivalent to seccomp-bpf. Filed as future work if cross-process injection becomes a realistic threat model item. |
| **Windows: AppContainer DLL path grants** | Low | `bun.exe` loads runtime DLLs from its install directory. `System32` has `ALL_APPLICATION_PACKAGES` ACE so system DLLs load correctly. If bun's install dir lacks this ACE, the AppContainer child may fail to start; the launcher falls back to unconfined in that case. True fix: grant `ALL_APP_PACKAGES` on the bun install dir during install. Pending real-machine validation. |
| **Windows: named pipes / COM not protected by AppContainer** | Low | Some legacy COM objects and named pipes with default DACLs may be accessible even from AppContainer. Not a primary threat in the local agent model. |
| **Windows: no sandbox tests in CI** | Low | `sandbox-escape.linux.test.ts` and `seatbelt.macos.test.ts` run in CI; there is no equivalent `win32.test.ts`. The CI compile gate (ci.yml) validates both Windows launchers build cleanly. `packages/sandbox/test/smoke/appcontainer-win32.ts` drives the AppContainer launcher on a real Windows host (confinement, orphan sweep, ACE lifecycle) and **passes live on Win11 ARM64 26200**; it is not yet wired into CI (no Windows runtime runner). Pending CI integration. |
| **`seccomp: 2` test fragile inside Docker** | Info | `/proc/self/status Seccomp: 2` check assumes the process is not already in a seccomp sandbox. Docker's default seccomp profile will cause the check to pass incorrectly in some CI configurations. The test is already guarded by `if (!makeLandlockLauncher()) process.exit(0)` but there's no guard against a pre-existing filter. |

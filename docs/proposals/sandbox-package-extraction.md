# Proposal: extract `@monad/sandbox`, open the backend contract, fill the network/credential gaps

Status: **implemented** — the extraction shipped as `packages/sandbox` (`@monad/sandbox`: launchers, egress proxy/policy, MITM, credential sentinel, registry); current hardening status lives in `docs/engineering/security-guidelines.md` §8. Body kept as the historical design record.

## Problem

The sandbox is already ~80% a package, but it is **scattered across four locations** with no single
owning boundary:

- **Contract** — `SandboxLauncher` / `SandboxPolicy` / `SandboxProcess` / `defineLocalLauncher` /
  `noneLauncher` live in `@monad/sdk-atom` (`src/sandbox.ts`).
- **Backends** — `packages/atoms/src/sandbox/`: `seatbelt`, `bwrap`, `landlock`, `win32`,
  `win32-appcontainer`, `docker`, `e2b`, wired by hardcoded imports in `packages/atoms/src/index.ts`.
- **Network + spawn + policy assembly** — `apps/monad/src/capabilities/tools/sandbox/`
  (`spawn`, `egress-policy`, `session-root`, `active-local`, `registry`) and
  `apps/monad/src/services/egress-proxy.ts`.
- **Native launchers** — `native/sandbox-launcher/` (Landlock+seccomp C, AppContainer C).

`sandboxedSpawn` already has **13 consumers** (daemon tools, `code-exec`, `process-runtime`, ACP
delegation, `workspace-git`, skills install, …). By `conventions.md` ("extract when the second copy
appears") this crossed the extraction bar long ago; the cost today is that the one security-critical
boundary in the system has no single home, and a contributor cannot add a backend without editing a
hardcoded import list in an unrelated package.

Two capability gaps also remain, both already documented in `security-guidelines.md` §8:

1. **Credential read-deny is all-or-nothing** and unenforced on the Linux Landlock fallback. There is no
   "inject the real secret on egress but keep it out of the process" path.
2. **`net:'filtered'` only mediates HTTP(S)** via the CONNECT/forward proxy. Non-HTTP TCP (SSH, DB,
   git-over-ssh) is not mediated — it is either killed by `net:'none'` or bypasses the allowlist under
   `filtered`.

## Non-goals

- **Not** matching `@anthropic-ai/sandbox-runtime` (srt) feature-for-feature. TLS-terminating MITM
  (per-host CA, URL-level HTTPS filtering) is **explicitly out of scope**: it buys URL-level filtering at
  the cost of a CA trust chain to manage, which is over-engineering for a local single-user daemon whose
  threat model is the browser and the model's own tool calls, not a MITM-capable network adversary.
- **Not** open-sourcing the package in this pass. See "Distribution" — open-sourcing adds a
  prebuilt-binary + Node-compat + API-stability tax (the same one srt pays as a "beta research preview").
  Ship it Bun-native and Monad-internal first; reconsider once the API settles and the gaps land.
- **Not** building a local-VM backend now. The registry will *admit* one (§ VM), but E2B and Docker
  already cover heavy isolation; a local VM is a subsystem, deferred until a concrete
  "run fully-untrusted code" requirement exists.

## Design

### 1. Package boundary

A new `@monad/sandbox` that consolidates the OS-level, Monad-agnostic pieces. Session/config/approval
coupling stays in `apps/monad` as a **consumer** of the package.

| Move into `@monad/sandbox` | Stay in `apps/monad` (consumer) |
|---|---|
| `SandboxLauncher` / `SandboxPolicy` / `SandboxProcess` contract (from sdk-atom) | `services/session-sandbox.ts` lifecycle (binds session store) |
| Light backends: `seatbelt`, `bwrap`, `landlock`, `win32`, `win32-appcontainer` | `OversightService` approval-gate wiring |
| `egress-proxy` + `egress-policy` + `spawn` + security primitives | config → `SandboxPolicy` assembly |
| native launcher path resolution (`native-path`) | boot sweep scheduling |

Decision rule: **OS-level and Monad-agnostic → in the package; coupled to session / config / approval →
stays and consumes it.**

The contract stays dependency-light. Either keep it in `@monad/sdk-atom` (protocol + zod only) and have
`@monad/sandbox` re-export, or move it into `@monad/sandbox`'s own contract entrypoint — but never let the
contract pull in a concrete backend (bwrap/e2b) as a dependency.

Heavy backends do **not** live in the core package (see § Layering).

### 2. Layering: core + opt-in heavy backends

```
@monad/sandbox          ← contract + light OS backends + egress + registry.  Small, dep-light, Bun-native.
@monad/sandbox-docker   ← heavy backend, opt-in, carries its own image/driver weight
@monad/sandbox-e2b      ← heavy backend (exists today), carries its own SDK
@monad/sandbox-vm       ← local VM, opt-in, carries hypervisor driver + image + pool (deferred)
```

The core ships the light path and the registry. Heavy backends are separate modules that plug into the
same registry and are enabled by config, so their images/drivers/SDKs never touch core cold-start or
bundle size.

### 3. Open the backend contract (declare-then-register)

Today `packages/atoms/src/index.ts` hardcodes the eight backend imports. Replace with a
**`sandbox-backend` atom kind** that both built-in and third-party backends register through — the same
manifest-gated, declare-then-register path used for `agent-adapter` (per `CLAUDE.md`: "Built-in and
third-party atom packs must load through the same manifest-gated path").

A contributor implements exactly three things:

```ts
interface SandboxBackend {
  launcher: SandboxLauncher          // spawn a process under confinement
  detect(): Promise<Availability>    // is this host capable? (bwrap on PATH, KVM present, …)
  conformanceTest: string            // path to a mandatory confinement test (see §4)
}
```

A **resolver** picks a backend from `(policy tier × host availability)`. It **never silently downgrades**:
if the policy asks for stronger isolation than any available backend provides, it surfaces the shortfall
(per `design-principles.md` "degrade predictably, never silently break") rather than quietly running a
weaker or `none` backend.

### 4. Security: a backend is the trust boundary, not ordinary I/O

A channel adapter that misbehaves fails to deliver a message. A launcher that misbehaves **breaks
confinement while the operator believes confinement holds** — e.g. a `noneLauncher` masquerading as a
confining one. Therefore, unlike normal atoms:

- **Mandatory confinement conformance test.** Every registered backend ships a test proving it actually
  denies out-of-root writes, credential reads, and (for `net:'none'`) socket creation. Templates already
  exist: `test/unit/tools/seatbelt.macos.test.ts`, `test/unit/tools/sandbox-escape.linux.test.ts`. A
  backend without a passing conformance test does not enter the registry.
- **Third-party backends require operator opt-in.** A `sandbox-backend` atom pack does not auto-activate
  by drop-in the way an ordinary atom does; the operator names it in config to enable it. The trust
  boundary is *which backend you enable*, mirroring the skill-provenance rule in `security-guidelines.md`.
- **Built-in backends are vetted and default-available.**

### 5. Fill the gaps (in the clean package, after migration)

Priority is set by Monad's actual threat model, not srt parity:

| Gap | Priority | Notes |
|---|---|---|
| **Credential sentinel injection** | high | Closes the §8 "Landlock-fallback credential read" gap and is strictly stronger than all-or-nothing read-deny: the process sees `fake_value_<uuid>`, the host-side egress proxy swaps sentinel→real **only** on egress to allowlisted inject-hosts. Real value never enters the process or logs. Port the shape from srt's `credential-sentinel` / `credential-mask-files` (Apache-2.0). |
| **SOCKS5 mediation** | high | Adds non-HTTP TCP (SSH, DB, git-ssh) to the mediated path under `filtered`, closing the raw-socket protocol blind spot. |
| **Violation monitoring** | medium | Make "what did the sandbox block" observable for debugging (macOS log-store tap / Linux monitor). |
| **TLS MITM / URL-level** | dropped | Out of scope — see Non-goals. |

### 6. VM: admit it, don't build it yet

VM is not a separate architecture — `e2b` (remote microVM) and `docker` already prove the
`SandboxLauncher` contract admits heavy isolation. A local-VM backend is "just another backend", but with
subsystem-level obligations the light backends don't have:

- **Lifecycle** — seconds to boot vs milliseconds; needs a VM **pool / reuse / snapshot** manager behind
  the launcher facade, not a single file.
- **Filesystem** — own FS; `writableRoots` shifts from "restrict host paths" to "mount workspace in, sync
  results out" (Docker Desktop / E2B "workspace sync").
- **Egress** — the host loopback proxy must be reachable from the guest (host-only net / upstream-proxy
  chaining), not just `HTTP(S)_PROXY` into a child.
- **Distribution** — adds VM image + per-OS hypervisor driver on top of the native-binary tax.

Plan: the registry and resolver support a `vm` isolation tier now (so policy can request it and the
resolver can route to E2B/Docker today); a local `@monad/sandbox-vm` backend is a placeholder until a
real untrusted-code requirement lands.

### Distribution / the native-binary tax

`native/sandbox-launcher/` (Landlock+seccomp, AppContainer) is the hard part of "standalone package", the
same tax srt pays (`apply_seccomp`, `srt-win.exe`). Decision: **keep `@monad/sandbox` Monad-internal and
Bun-native initially** — the binaries ride Monad's existing build, no external prebuilt-binary
distribution. Only if/when we open-source do we take on per-OS/per-arch prebuilt binaries + Node compat.

## Phasing

1. **Migrate (behavior-preserving).** Consolidate the four locations into `@monad/sandbox`; leave
   session/config/approval in `apps/monad` as consumers. Existing confinement tests
   (`seatbelt.macos`, `sandbox-escape.linux`) are the safety net. No new capability. One PR, no behavior
   change.
2. **Open the contract.** Introduce the `sandbox-backend` atom kind + resolver + mandatory-conformance
   gate; re-register the eight built-ins through it (delete the hardcoded imports). Add third-party
   opt-in.
3. **Fill gaps.** Credential sentinel injection first, then SOCKS5 mediation. Each with its own
   conformance test. Separate PRs — never bundle "extract" with "add capability".
4. **VM placeholder.** Land the `vm` isolation tier + resolver routing to E2B/Docker; stub
   `@monad/sandbox-vm`.

## Open questions

- Contract home: keep in `@monad/sdk-atom` and re-export, or relocate to `@monad/sandbox`? (Affects who
  depends on whom; sdk-atom must stay protocol+zod only.)
- Does `SandboxPolicy` already express "mount into guest" semantics well enough for docker/e2b, or does
  the VM tier force a policy-shape change that should be designed in at phase 1?
- Bun-native constraint for third-party backends: the contract uses `node:net`/`node:dns`; confirm a
  third-party backend authored against Node runs unmodified under Bun, or document the requirement.

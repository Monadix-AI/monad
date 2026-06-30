# Security Guidelines

Rules for writing security-sensitive code in monad. The threat model is specific:
**monad is a local, single-user daemon that listens on the loopback interface and
runs a tool-using LLM agent.** That shapes everything below — the adversary is not
(yet) a remote network attacker; it is **the user's own web browser** and **the
model's own tool calls**.

These rules are derived from a June 2026 audit of the current code. Each section
states the rule, the why, and how to apply it. Treat the checklist at the end as a
PR gate for any change that touches a network boundary, the filesystem, a
credential, or tool dispatch.

---

## Threat model — who the attacker is

1. **The browser (primary, today).** monad binds `127.0.0.1`. Any web page the user
   visits can issue requests to `http://127.0.0.1:<port>` and open
   `ws://127.0.0.1:<port>`. The loopback IP allowlist does **not** identify the
   *caller* — only that the packet came from this machine. A malicious origin is
   "localhost" as far as the socket is concerned.
2. **The model (primary, once tools land).** Tool arguments are attacker-controlled
   data: prompt injection from a fetched web page, a file, or a connector can make
   the model emit `fs_read("/etc/shadow")` or `net_fetch("http://169.254.169.254/…")`.
   Treat every tool argument as hostile input, never as trusted intent.
3. **Other local users (shared host).** Files and sockets under `~/.monad/` must not
   be readable by siblings on a multi-user machine.
4. **The remote network (only when `remoteAccess.enabled`).** Opt-in, binds
   `0.0.0.0`, bearer-token gated. Lowest-frequency but highest-blast-radius.

> The IP/loopback check answers "did this come from this machine?" — **never** "is
> this caller allowed?" Those are different questions. Authentication and
> authorization need their own controls (Origin checks, tokens, capability scoping).

---

## 1. Network boundary: validate Origin, not just IP

A loopback peer address is not a principal. Any browser tab is a loopback peer.

- **REST writes are CSRF-exploitable.** A page can POST to `127.0.0.1` without
  reading the response (no CORS needed to *send*). Any state-changing endpoint
  (`session.create`, `session.send`, settings mutations) must reject requests whose
  `Origin`/`Sec-Fetch-Site` indicate a cross-site browser caller. Maintain an
  allowlist of trusted origins (the bundled web UI, `tauri://`, `null` for native);
  reject everything else, even from loopback.
- **WebSocket has no same-origin protection at all.** Browsers send no preflight and
  enforce no CORS on `ws://`. The `/v1/stream` handler currently accepts any
  connection and dispatches full JSON-RPC — this is Cross-Site WebSocket Hijacking
  (CSWSH). **Validate the `Origin` header in the WS upgrade handler and refuse
  mismatches.** This is the single most important control to add.
- **Defend against DNS rebinding.** Validate the `Host` header against an allowlist
  (`127.0.0.1:<port>`, `localhost:<port>`). Rebinding turns "loopback only" into
  "any website, eventually."
- **Never reflect `Origin` into `Access-Control-Allow-Origin` together with
  `Access-Control-Allow-Credentials: true`.** That combination tells the browser
  every origin is trusted *and* may read credentialed responses. Echo only origins
  from the allowlist; if an origin isn't allowed, omit the header — don't reflect it.

## 2. Authenticate remote callers properly

When `remoteAccess.enabled` (bind `0.0.0.0`):

- Require a bearer token for every non-loopback request (current behavior — keep it).
- Compare tokens in **constant time** (`crypto.timingSafeEqual` over equal-length
  buffers), not `===`. String compare leaks length and prefix via timing.
- Generate tokens with a CSPRNG (`crypto.randomBytes`/`randomUUID`), ≥128 bits.
- **Document that plain-HTTP remote access is insecure**: the token travels in
  cleartext. Require a TLS-terminating reverse proxy, SSH tunnel, or VPN. Never
  advertise `http://0.0.0.0:<port>` as a usable remote endpoint.
- The loopback bypass (`if (LOCALHOST.has(addr)) return`) is acceptable for *network*
  auth but does **not** replace the Origin/Host checks from §1 — both are required.

## 3. Filesystem permissions: lock every artifact under `~/.monad/`

Default umask leaves files world-readable (0644). Secrets need explicit perms.

- **Any file holding a secret gets `chmod 0o600` immediately after write**, inside
  the same function, before it can be read. Today only `auth.json` does this
  (`config.ts` `setSecurePermissions`). **`config.json` holds
  `network.remoteAccess.token` and is currently NOT locked down — fix it, and apply
  the same to any new secret-bearing file.**
- **The Unix control socket needs `chmod 0o600` (or 0o700) too.** `Bun.serve({ unix })`
  does not set restrictive perms; the socket grants full unauthenticated RPC to
  anyone who can `connect()` it. Do not rely on the parent directory's mode alone —
  set it on the socket explicitly after creation, and create `~/.monad/run/` as 0o700.
- Windows has no `chmod`; the current code no-ops there. Document the gap and rely on
  per-user profile ACLs; don't pretend the file is protected.
- Treat the socket's filesystem permissions as its *only* authentication — that is by
  design ("filesystem-permission gated"), so the permissions must actually be set.

## 4. Tools execute attacker-controlled arguments — gate and validate them

Tool dispatch is not wired yet, but the scaffolding (`apps/monad/src/capabilities/tools`,
`withSandboxConstraints` in `main.ts`) attaches sandbox roots as **metadata that is
never enforced**. The call-time guards below now exist as tested primitives in
the daemon built-in tools (`apps/monad/src/capabilities/tools/security.ts`): `assertPathWithinRoots`,
`assertUrlAllowed`, `isBlockedIp`, `ToolSecurityError`. Tool `run()` bodies MUST call
them — `net_fetch` already does. Before any tool is made callable:

- **Validate every argument at the dispatch boundary.** Declare `Tool.inputSchema`
  (a zod schema, or any `ToolInputSchema`); `invokeTool` parses the raw input before
  the gate or `run()`, rejecting bad input with `ToolInputError` and passing the
  coerced result to `run`. Never cast attacker-controlled input. The three built-in
  tools each carry a schema.
- **Enforce filesystem sandboxing at call time, not declaration time.** The agent's
  effective roots arrive on `ToolContext.sandboxRoots` (injected by `invokeTool`);
  fs tools call `assertPathWithinRoots(path, ctx.sandboxRoots)` — `fs_read` already
  does. It resolves and rejects `..`/absolute escapes lexically. A constraint the tool
  doesn't check is decoration. Caveat: when opening an EXISTING file, also `realpath`
  and re-check, since a symlink inside the sandbox can point out of it.
- **SSRF-filter every outbound fetch.** `assertUrlAllowed(url)` denies loopback,
  link-local (`169.254.0.0/16`, cloud metadata), private ranges (RFC 1918), and
  non-`http(s)` schemes by literal host. It CANNOT catch a public name that resolves
  to a private IP, so the fetch impl must **also** resolve DNS and re-check the
  address with `isBlockedIp` — plus a redirect cap, timeout, and response-size limit.
  The daemon's own API on `127.0.0.1` is a prime SSRF target.
- **Route high-risk tools through the approval gate.** Every tool call goes through
  `invokeTool` (`@monad/agent-core`), which sends `highRisk` tools to the host-supplied
  `ToolGate` before running and is **fail-closed**: high-risk + no gate configured →
  denied. The daemon ships a real gate — `OversightService` (apps/monad): it emits a
  `tool.approval_requested` event, blocks the turn, and resolves only when a client
  answers via the `tools.approve` RPC, or auto-denies after a timeout. Never call
  `tool.run()` directly from the loop — go through `invokeTool` so the gate and sandbox
  context are always applied.
- **No shell string interpolation.** If a tool ever shells out, use `Bun.$` with
  array args / tagged-template escaping — never build a command string from model
  output. Prefer native APIs (`Bun.file`, `fetch`) over spawning.

## 5. Validate and bound all external input

Every HTTP/WS/disk boundary parses with zod (the schema *is* the type — see
[conventions.md](conventions.md)). Add the limits the schemas omit:

- **Size-cap user strings** — `z.string().max(N)`. `createSessionRequestSchema.title`
  and `sendMessageRequestSchema.text` are currently unbounded → memory-exhaustion DoS.
- **Cap request bodies** at the server (Elysia/Bun limit) regardless of schema.
- **Rate-limit per connection** on `session.create`/`session.send` — unbounded calls
  exhaust disk, the DB, and trigger unbounded paid model inference.
- Never `parse` external data with `as` casts; never trust a header's claim about who
  the caller is.

## 6. Credentials and logging

- **Mask secrets in every API response** (`maskSecret` / `…last4`) — never return a
  raw token, API key, or access token. This is done today for model credentials;
  hold the line for any new credential surface.
- **Never log secrets.** No tokens, API keys, auth headers, or credential payloads in
  logs — including the debug log under `tmpdir()` (world-readable on some hosts) and
  webhook/connector logs. Scrub before logging.
- **Keep dev-only secret loading dev-only.** `dev-init.ts` reads `OPENROUTER_API_KEY`
  from env and persists it to `auth.json`; it is gated on non-production — keep that
  gate, and ensure `auth.json` and `config.json` are in `.gitignore` so a persisted
  key can never be committed.
- **Validate webhook payloads.** Verify the HMAC against the **raw** body with
  `verifyWebhookSignature` (`@monad/connectors`) before ingesting — a webhook URL is an
  unauthenticated entry point. Add per-source rate limiting (`createIpRateLimiter`). The
  primitive exists; wire it when the webhook route is mounted.

## 7. Data layer (keep it safe)

- **All SQL stays parameterized.** The store uses Drizzle + bound `?`/`$named`
  placeholders and escapes FTS phrase input — **no string-interpolated untrusted
  data.** Any new raw query must bind parameters; never interpolate IDs, search
  terms, or session ids into SQL text.
- **Session `origin.env` is PII — keep it off the model and out of logs.** The session
  origin snapshot (`@monad/protocol` `sessionOriginSchema`) carries an `env` block
  (raw IP, user-agent, OS, locale, workspace) captured at creation **for audit only**.
  It MUST NOT be added to the model context (prompt-injection + privacy) and MUST NOT be
  logged. `env.ip` is a raw client IP: treat it as personal data — never echo it in an
  API response body, and purge it when its session is deleted (no separate retention copy).
  Identity fields (`surface`/`client`/`writableBy`) are safe to surface in the UI; `env` is not.
- **`origin.ext` is untrusted client input — bounded, raw-rendered, off the model.** The open
  extension bag (`sessionOriginExtSchema`) is client-defined and persisted. It is size-bounded at the
  schema (≤32 keys, ≤4KB serialized) so a client can't bloat the row; a UI may only render it as raw
  text (React escapes — never `dangerouslySetInnerHTML` it), and it MUST NOT enter the model context.

---

## 8. Sandbox confinement — hardening status

This section tracks what OS-level confinement has been shipped and what gaps remain.
Update it when a hardening item lands or is deliberately deferred.

### Implemented

**macOS — Seatbelt (`sandbox-exec`)**
- FS writes restricted to declared `writableRoots` via SBPL profile generated at spawn time.
- `readDenyRoots` adds last-match-wins deny rules to block reads of credential directories
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, credentials store) even under open egress.
- `net: 'none'` denies all outbound connections at the kernel level.
- `net: { allowProxyPort }` permits only the local filtering proxy; all other sockets denied.
- `net: 'unrestricted'` leaves egress fully open (default for development convenience).
- Tests: `apps/monad/test/unit/tools/seatbelt.macos.test.ts` (live kernel, 7 cases).

**Linux — bwrap (preferred, when installed) + Landlock + seccomp-bpf** (`packages/atoms/src/sandbox/bwrap.ts`, `native/sandbox-launcher/main.c`)

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
  AF_INET6 block + default-net allow). Verified live against kernel 6.17 (Landlock + seccomp).

**Windows — AppContainer (preferred) + Low Integrity fallback** (`native/sandbox-launcher/windows-appcontainer.c`, `windows.c`)

AppContainer launcher (`monad-sandbox-appcontainer.exe`) — selected when present:
- Child launched via `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
  into a named AppContainer profile (`monad.<sessionId>`).
- Writable roots granted `GENERIC_ALL` for the AppContainer SID before launch.
- Credential dirs (`~/.ssh`, `~/.aws`, `~/.gnupg`, etc.) get an explicit `DENY_ACCESS` ACE for
  the AppContainer SID — **closes the credential read-deny gap** that Low IL cannot address.
- `net:'none'` enforced by omitting all network capability SIDs: the child has no IP sockets.
- `net:'filtered'`/`'unrestricted'` grant `INTERNET_CLIENT + INTERNET_CLIENT_SERVER + LOCAL_LOOP`
  capabilities; domain filtering relies on the egress proxy (app-layer, same as Linux filtered).
- Profile lifecycle: per-session profiles created lazily, cleaned up via `disposeSession()`.
  Falls back to unconfined `CreateProcessW` when `CreateAppContainerProfile` is unavailable
  (pre-Win8 or restricted CI environments) so old environments stay functional.
- Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` in both launchers.

Low Integrity launcher (`monad-sandbox-launcher.exe`) — fallback when AppContainer binary absent:
- Child launched under a Low IL token (`S-1-16-4096`) via `DuplicateTokenEx` + `SetTokenInformation`.
- Prevents writes to Medium/High integrity objects. Does NOT enforce readDeny or net isolation.

**Egress filtering (all platforms)**
- `apps/monad/src/services/egress-proxy.ts`: raw-TCP local proxy on `127.0.0.1:0`
  (port auto-assigned). Handles `CONNECT` tunneling and HTTP forwarding.
- Domain allowlist: `isEgressAllowed(host, policy)` in `egress-policy.ts`; subdomain
  matching; loopback/private/link-local always blocked (SSRF guard) even with `'*'`.
- DNS rebinding protection: all resolved addresses checked with `isBlockedIp`.
- When `net: 'filtered'`, the proxy port is the only allowed egress; `HTTP(S)_PROXY` env
  vars injected into child so `curl`/`pip`/`npm`/`git clone` route through it transparently.
- **Enforcement tier differs by net mode + platform.** `net:'none'` is OS-enforced on macOS
  (Seatbelt `deny network*`) **and Linux** (seccomp `socket(AF_INET/6)` block); on Windows it is
  advisory. `net:'filtered'` is **application-layer on every platform** — the proxy + `HTTP(S)_PROXY`
  env. A child that opens a raw socket instead of honouring the proxy env bypasses *filtered* on
  Linux/Windows (macOS Seatbelt still confines it to the proxy port). See Known gaps.

### Known gaps / pending

| Gap | Severity | Notes |
|---|---|---|
| **Linux: `net:'filtered'` is app-layer (raw-socket bypass)** | Medium | `net:'none'` is now kernel-enforced on Linux (seccomp blocks `socket(AF_INET/6)`), so a no-egress sandbox is real. But `net:'filtered'` still relies on the application-layer proxy + `HTTP(S)_PROXY` env: seccomp can't allow-by-destination-IP, so a child that opens a raw socket instead of honouring the proxy bypasses the domain allowlist. True per-destination filtering requires a network namespace (`unshare --net` + veth/nft, needs `bubblewrap` or unprivileged userns). Deferred — `net:'none'` covers the "no exfil at all" case; filtered covers the cooperative-tooling case (package managers / curl). |
| **Linux: `net:'filtered'` is app-layer (raw-socket bypass)** | Medium | `net:'none'` is kernel-enforced on Linux (seccomp blocks `socket(AF_INET/6)`). `net:'filtered'` relies on the proxy + `HTTP(S)_PROXY` env; a raw socket from the child bypasses it. True per-destination filtering requires a network namespace (bubblewrap/userns). Deferred. |
| **Windows: `net:'filtered'` is app-layer** | Low | AppContainer `net:'none'` removes all network capabilities — enforced. `net:'filtered'` still grants `INTERNET_CLIENT` capabilities and relies on the egress proxy; a raw socket can bypass the domain allowlist. WFP filters would close this. Deferred. |
| **Linux: credential read-deny enforced only when bwrap is installed** | Low | When `bwrap` is on PATH, `bwrapLauncher` is auto-selected and enforces readDeny: confined mode simply never binds credential dirs; unrestricted-write mode overlays `--tmpfs` over each deny path. When `bwrap` is absent (minimal containers, Alpine) `landlockLauncher` takes over; Landlock is an additive read-allowlist and cannot express deny — the gap remains on those hosts and the daemon warns at boot. |
| **macOS: seccomp equivalent missing** | Low | Seatbelt's `(deny process*)` can prevent fork/exec but there is no fine-grained syscall filter equivalent to seccomp-bpf. Filed as future work if cross-process injection becomes a realistic threat model item. |
| **Windows: AppContainer DLL path grants** | Low | `bun.exe` loads runtime DLLs from its install directory. `System32` has `ALL_APPLICATION_PACKAGES` ACE so system DLLs load correctly. If bun's install dir lacks this ACE, the AppContainer child may fail to start; the launcher falls back to unconfined in that case. True fix: grant `ALL_APP_PACKAGES` on the bun install dir during install. Pending real-machine validation. |
| **Windows: named pipes / COM not protected by AppContainer** | Low | Some legacy COM objects and named pipes with default DACLs may be accessible even from AppContainer. Not a primary threat in the local agent model. |
| **Windows: no sandbox tests in CI** | Low | `sandbox-escape.linux.test.ts` and `seatbelt.macos.test.ts` run in CI; there is no equivalent `win32.test.ts`. The CI compile gate (ci.yml) validates both Windows launchers build cleanly, but runtime behaviour tests require a real Windows environment. Pending. |
| **`seccomp: 2` test fragile inside Docker** | Info | `/proc/self/status Seccomp: 2` check assumes the process is not already in a seccomp sandbox. Docker's default seccomp profile will cause the check to pass incorrectly in some CI configurations. The test is already guarded by `if (!makeLandlockLauncher()) process.exit(0)` but there's no guard against a pre-existing filter. |

Touching a network boundary, the filesystem, a credential, or tool dispatch? Confirm:

- [ ] New/changed HTTP+WS endpoints validate **Origin** and **Host** (not just IP).
- [ ] WebSocket upgrade rejects untrusted origins (CSWSH).
- [ ] No `Access-Control-Allow-Origin: <reflected>` paired with `allow-credentials: true`.
- [ ] Remote-auth token compared with `timingSafeEqual`; tokens are CSPRNG ≥128-bit.
- [ ] Every new secret-bearing file is `chmod 0o600` in the same function that writes it.
- [ ] New Unix sockets / their parent dirs have restrictive perms set explicitly.
- [ ] Every external input (HTTP/WS/disk) is zod-`parse`d, never cast; user strings `.max()`-bounded.
- [ ] Request bodies size-capped; hot endpoints rate-limited.
- [ ] Tool arguments schema-validated at dispatch; fs paths resolved+sandbox-checked at call time.
- [ ] Outbound fetches SSRF-filtered (post-DNS), with timeout/redirect/size caps.
- [ ] High-risk tools pass through the approval gate before executing.
- [ ] No shell command built from model/user output.
- [ ] Secrets masked in responses and never written to any log.
- [ ] New SQL binds parameters; no interpolated untrusted data.
- [ ] Code spawning a child process uses `sandboxedSpawn`, not bare `Bun.spawn`; new `writableRoots` are intentional and minimal.
- [ ] Changes to `SandboxPolicy` or `buildSeatbeltProfile`/`apply_landlock`/`apply_seccomp` are reflected in §8 above and covered by a confinement test.

---
title: "Security Guidelines"
audience: "internal-developer"
description: "Rules for writing security-sensitive code in Monad. The threat model is specific: Monad is a local, single-user daemon that listens on the loopback."
---
Rules for writing security-sensitive code in Monad. The threat model is specific:
**Monad is a local, single-user daemon that listens on the loopback interface and
runs a tool-using LLM agent.** That shapes everything below — the adversary is not
(yet) a remote network attacker; it is **the user's own web browser** and **the
model's own tool calls**.

These rules are derived from a security audit of the current code. Each section
states the rule, the why, and how to apply it. Treat the checklist at the end as a
PR gate for any change that touches a network boundary, the filesystem, a
credential, or tool dispatch.

---

## Threat model — who the attacker is

1. **The browser (primary, today).** Monad binds `127.0.0.1`. Any web page the user
   visits can issue requests to `http://127.0.0.1:<port>` and open
   `ws://127.0.0.1:<port>`. The loopback IP allowlist does **not** identify the
   *caller* — only that the packet came from this machine. A malicious origin is
   "localhost" as far as the socket is concerned.
2. **The model (primary, once tools land).** Tool arguments are attacker-controlled
   data: prompt injection from a fetched web page, a file, or a connector can make
   the model emit `file_read("/etc/shadow")` or `net_fetch("http://169.254.169.254/…")`.
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

A loopback peer address does not authenticate the caller. Any browser tab can be a loopback peer.

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

- **Any file holding a secret should be owner-only.** `auth.json` is written `0600`;
  native credentials now live in `config.json`, `agents.json`, and `mesh.json`, so
  users must protect those files and installers should apply owner-only permissions
  where the platform supports them.
- **The Unix control socket needs `chmod 0o600` (or 0o700) too.** `Bun.serve({ unix })`
  does not set restrictive perms; the socket grants full unauthenticated RPC to
  anyone who can `connect()` it. Do not rely on the parent directory's mode alone —
  set it on the socket explicitly after creation, and create `~/.monad/runtime/` as 0o700.
- Windows has no `chmod`; the current code no-ops there. Document the gap and rely on
  per-user profile ACLs; don't pretend the file is protected.
- Treat the socket's filesystem permissions as its *only* authentication — that is by
  design ("filesystem-permission gated"), so the permissions must actually be set.

## 4. Tools execute attacker-controlled arguments — gate and validate them

Tool dispatch is live. `withSandboxConstraints` (`apps/monad/src/capabilities/protection.ts`,
applied in `capabilities/lifecycle.ts`) attaches the effective sandbox roots to each tool, and
`invokeTool` injects them into `ToolContext` — but attaching a constraint is not enforcing it.
The call-time guards are tested primitives in `@monad/sandbox`
(`packages/sandbox/src/security.ts`): `assertPathWithinRoots`, `assertUrlAllowed`,
`isBlockedIp`, `ToolSecurityError`. Tool `run()` bodies MUST call them. The rules below apply
to every tool, and to every new one:

- **Validate every argument at the dispatch boundary.** Declare `Tool.inputSchema`
  (a zod schema, or any `ToolInputSchema`); `invokeTool` parses the raw input before
  the gate or `run()`, rejecting bad input with `ToolInputError` and passing the
  coerced result to `run`. Never cast attacker-controlled input. The three built-in
  tools each carry a schema.
- **Enforce filesystem sandboxing at call time, not declaration time.** The agent's
  effective roots arrive on `ToolContext.sandboxRoots` (injected by `invokeTool`);
  file tools call `assertPathWithinRoots(path, ctx.sandboxRoots)` — `file_read` already
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
  `invokeTool` (`apps/monad/src/capabilities/tools/invoke.ts`), which sends `highRisk` tools to the host-supplied
  `ToolGate` before running and is **fail-closed**: high-risk + no gate configured →
  denied. The daemon ships a real gate — `OversightService` (`apps/monad/src/services/oversight.ts`): it emits a
  `tool.approval_requested` event, blocks the turn, and resolves only when a client
  answers via the `tools.approve` RPC, or auto-denies after a timeout. Never call
  `tool.run()` directly from the loop — go through `invokeTool` so the gate and sandbox
  context are always applied.
- **No shell string interpolation.** If a tool ever shells out, use `Bun.$` with
  array args / tagged-template escaping — never build a command string from model
  output. Prefer native APIs (`Bun.file`, `fetch`) over spawning.

## 5. Validate and bound all external input

Every HTTP/WS/disk boundary parses with zod (the schema *is* the type — see
[code conventions](conventions.md)). Add the limits the schemas omit:

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
- **Mask secrets in local reads too, not just API responses.** A command that parses a settings
  file directly (`monad config`) bypasses the daemon's masking entirely. Mask by key name, not by a
  list of known paths, so a new secret field is covered the day it lands; gate any `--reveal` escape
  hatch on an interactive TTY, since redirects, pipes, and `--json` captures are how a revealed
  secret actually leaks.
- **Never accept a secret as a command-line argument.** argv is readable by every local user via
  `ps` and is written to shell history — the same exposure class as logging it. Take secrets on
  stdin (`-`) or from a file (`--token-file`), and document only those forms.
- **Never log secrets.** No tokens, API keys, auth headers, or credential payloads in
  logs — including the debug log under `tmpdir()` (world-readable on some hosts) and
  webhook/connector logs. Scrub before logging.
- **Keep dev-only secret loading dev-only.** Live model tests may read
  `OPENROUTER_API_KEY` from the environment; keep that path gated to development and
  test use, and ensure all Monad settings files are ignored so a persisted key can
  never be committed.
## 7. Data layer (keep it safe)

- **All SQL stays parameterized.** The store uses Drizzle + bound `?`/`$named`
  placeholders and escapes FTS phrase input — **no string-interpolated untrusted
  data.** Any new raw query must bind parameters; never interpolate IDs, search
  terms, or session ids into SQL text.
- **Keep `OperationSource` provenance-only and server-stamped.** Persist only
  `surface`, `client`, optional client/instance identifiers, and the server-derived
  semantic `transport`. Do not restore the removed `origin.env` PII snapshot, open
  `origin.ext` bag, or client-configurable `writableBy`/`branchableBy` arrays.
- **Do not treat provenance as identity.** Connection admission, scoped runtime capabilities,
  and tool approval own authorization.
  The temporary `assertTransportAuthority` comparison is a narrow containment rule for
  session mutations while the trusted-native versus model-child boundary is completed;
  do not reuse it as a general RBAC mechanism.

---

## 8. Sandbox confinement — hardening status

The shipped OS-level confinement and its known gaps are documented with the code that
implements them: **[`packages/sandbox/docs/hardening.md`](https://github.com/Monadix-AI/monad/blob/main/packages/sandbox/docs/hardening.md)**.
Read it before changing a launcher, a policy field, or an egress rule; update it in the
same change.

Summary of what enforces what today:

| Platform | Mechanism | `net:'none'` | Credential read-deny |
|---|---|---|---|
| macOS | Seatbelt (`sandbox-exec`) | kernel-enforced | enforced (`readDenyRoots`) |
| Linux | bwrap when installed, else Landlock + seccomp-bpf | kernel-enforced (seccomp blocks `socket(AF_INET/6)`) | bwrap only — Landlock cannot express deny |
| Windows | AppContainer, Low Integrity fallback | enforced (no network capability SIDs) | AppContainer only (deny ACE) |

`net:'filtered'` is **application-layer on every platform** — the muxed HTTP/SOCKS5 egress
proxy in `@monad/sandbox` plus injected `HTTP(S)_PROXY`/`ALL_PROXY`; a child that opens a
raw socket bypasses the domain allowlist everywhere except macOS. Optional TLS termination
and Agent Credential protected execution build on that proxy. The heavy backends
(docker/e2b/vm) live in `@monad/monad-power-pack`, not the built-in set; the VM backend's
evidence rules are in
[`packages/sandbox-vm/docs/conformance.md`](https://github.com/Monadix-AI/monad/blob/main/packages/sandbox-vm/docs/conformance.md).

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
- [ ] Secrets masked in responses **and in any local file the CLI reads itself**; never written to any log.
- [ ] No command takes a secret as a positional argument or flag value; stdin/file forms exist and are what the docs show.
- [ ] New SQL binds parameters; no interpolated untrusted data.
- [ ] Code spawning a child process uses `sandboxedSpawn`, not bare `Bun.spawn`; new `writableRoots` are intentional and minimal.
- [ ] Changes to `SandboxPolicy` or `buildSeatbeltProfile`/`apply_landlock`/`apply_seccomp` are reflected in [`packages/sandbox/docs/hardening.md`](https://github.com/Monadix-AI/monad/blob/main/packages/sandbox/docs/hardening.md) and covered by a confinement test.

# Application Design Principles

Higher-altitude rules for **how features are designed** in monad, before any code is
written. Two principles govern every feature: it must behave the same on every
platform, and it must be safe to run a tool-using agent against the user's machine.
Concrete, code-level rules live in the focused docs ([security-guidelines.md](security-guidelines.md),
[conventions.md](conventions.md), [cli-design.md](cli-design.md)); this document is the design intent
those rules serve.

## 1. Cross-platform parity

monad ships to **macOS, Linux, and Windows** (the daemon, CLI, and web UI all
target all three). A feature is not done until it behaves identically on each.

- **Same behaviour, same surface.** A user scripting against monad on Linux and a
  user on Windows see the same commands, the same outputs, the same semantics.
  Platform is an implementation detail, never a behavioural one.
- **Push platform differences into a thin glue layer.** When platforms genuinely
  need different dependencies or implementations (different syscalls, sockets,
  paths, binaries), isolate that behind a **narrow adapter with a single uniform
  interface**. Feature code calls the interface; it never branches on the OS.
  - *Reference pattern:* the transport layer. The daemon serves the same REST + SSE
    API over TCP loopback and a Unix-domain socket; the per-OS default (`uds` on
    Linux, `tcp` on macOS/Windows) and the automatic fallback when a socket can't
    be dialled are decided **inside** the transport adapter. The CLI asks for "the
    client" — it does not contain `if (platform === 'win32')`.
- **No scattered `process.platform` checks.** If OS-conditional logic is leaking
  into feature code, the glue layer is in the wrong place or too thin. Centralize
  it, expose one interface, and keep the branch in exactly one file.
- **Degrade predictably, never silently break.** Where a platform's capability is
  weaker (e.g. Bun's incomplete Unix-socket support on Windows), the glue layer
  falls back to a working path and the feature stays reachable — the setting never
  makes the product unusable on that OS.
- **Verify on every platform.** Per [AGENTS.md](../AGENTS.md), exercise each
  `apps/monad` feature over **all transports**, and CI runs the full suite on
  Ubuntu, macOS, and Windows. A green build on one OS is not coverage.

## 2. Security-first — contain the agent

monad runs a **tool-using LLM agent on the user's own machine**. Every feature is
designed to keep that agent contained. Design against three failure modes:

- **Don't let the agent damage the host.** A feature that gives the model
  filesystem, network, or process reach must scope and gate that reach — never hand
  it ambient, unscoped access to the host. Default to least privilege; widen only
  with an explicit, validated capability.
- **Don't leak sensitive information.** Credentials, tokens, and user data must not
  flow into model context, logs, tool outputs, or telemetry by default. Treat
  egress (what the agent can read and where it can send it) as a boundary to be
  designed, not an afterthought.
- **Assume injection from every agent-reachable channel.** Prompts, tool arguments,
  and the payloads of **atom packs, MCP servers, and skills** are all
  attacker-controlled input. A malicious web page, file, connector, or third-party
  skill can try to steer the model into hostile tool calls. Treat all of it as
  hostile data, never as trusted intent — validate and constrain at the boundary,
  do not act on it directly.

This is the design *principle*. The code-level controls that enforce it — Origin
validation, capability scoping, tool-argument gating, credential handling,
filesystem permissions, the PR security checklist — are specified in
[security-guidelines.md](security-guidelines.md). Read it before building anything
that touches a network boundary, the filesystem, a credential, or tool dispatch.

# Security Policy

## Supported versions

monad is pre-1.0 and evolving quickly. Security fixes are applied to the
`main` branch and the latest release only. Older releases are not patched —
please upgrade before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Monadix-AI/monad/security/advisories/new)
("Report a vulnerability" under the repo's **Security** tab). This keeps the
report confidential until a fix is available and lets us coordinate a release
with you.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept is ideal).
- Affected version / commit and platform (macOS, Linux, Windows).
- Any suggested remediation, if you have one.

We aim to acknowledge reports within **3 business days** and to provide a
remediation timeline after triage. We're happy to credit you in the release
notes once a fix ships — let us know how you'd like to be named.

## Scope and threat model

monad is a **local, single-user daemon**. Understanding what is and isn't in
scope will help you decide whether a finding is a vulnerability:

- By default the daemon binds **loopback only** (`127.0.0.1`) plus a
  Unix-domain socket under `~/.monad/run/`. Neither is reachable from another
  machine — a bound loopback port is not an exposed port.
- The in-scope adversaries today are the user's **own web browser** (any page
  can reach `127.0.0.1`) and the **model's own tool calls**. A remote network
  attacker is not yet in scope unless remote access is explicitly enabled.
- **Remote access** (`network.remoteAccess.enabled`) binds `0.0.0.0` and
  requires a bearer token. Plain-HTTP remote access transmits that token in
  cleartext and is expected to sit behind TLS (reverse proxy / SSH tunnel /
  VPN). Reports about cleartext tokens on an unprotected `http://0.0.0.0` are
  known and documented, not vulnerabilities.

This is an **evolving** posture, not a hardened one. The corresponding
hardening work is tracked in
[docs/engineering/security-guidelines.md](docs/engineering/security-guidelines.md). Findings that
demonstrate a bypass of the documented model — or that escalate beyond it —
are very much in scope and welcome.

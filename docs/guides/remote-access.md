---
title: "Access Monad from Another Device"
sidebarTitle: "Remote Access"
description: "Enable Monad remote access deliberately with TLS, bearer authentication, and a contained network boundary."
keywords: ["Monad remote access", "TLS", "bearer token", "Tailscale", "daemon security"]
---
Monad binds to loopback by default. Keep that default unless another device genuinely needs to reach the daemon.

## Before enabling access

- Treat the daemon API as a control plane, not a public web API.
- Prefer a private network such as an operator-owned tailnet over direct internet exposure.
- Protect the remote bearer token as a credential.
- Review the tools, sandboxes, channels, and agent runtimes the daemon can reach.
- Keep developer mode off; local Scalar includes internal routes and must not be publicly proxied.

## Enable it

Enabling remote access is the one setup flow that runs in the browser: **Settings →
Connection**. Turning it on makes the daemon generate the bearer token itself, enable TLS
in the same write, and show the token once so you can copy it. Plain-HTTP remote access
requires an explicit confirmation.

There is deliberately no `monad config set network.remoteAccess.token …`: a secret passed
as an argument is readable by every local user through `ps` and lands in shell history.
Flipping `network.remoteAccess.enabled` by hand in `config.json` would also leave the
token empty, so use the Connection screen.

The CLI owns everything around it:

```bash
monad status                 # the listener, scheme, and address actually in use
monad remote tls show        # certificate fingerprint and expiry
monad remote tls renew       # reissue the daemon certificate
monad remote tls trust       # add it to this machine's trust store
monad restart                # apply a listener change
```

Clients then point at that daemon per invocation, reading the token from a file rather
than argv:

```bash
monad status --host monad.example.com --token-file ~/.monad/remote-token
```

## Runtime protections

When remote access is enabled, non-loopback TCP requests require the configured bearer token. The daemon applies per-IP rate limiting before token comparison and keeps browser-origin checks separate from bearer authentication. Local Unix-socket and loopback clients retain their local trust behavior.

TLS configuration and certificate status belong to the daemon's network settings. Confirm the listener, scheme, certificate fingerprint, and expiry from a trusted local client before connecting another device.

## Validation checklist

1. Run `monad status` locally and confirm the intended listener.
2. Confirm remote access is disabled on interfaces you did not intend to expose.
3. Connect from the second device over the private network using the bearer token.
4. Verify an unauthenticated remote request is rejected.
5. Verify the required client can read health and perform only its intended workflow.
6. Review logs without copying credentials into a bug report.

For exact configuration fields and transport behavior, read [runtime, transport, configuration, and security](/internals/infra/runtime).


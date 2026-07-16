# Daemon lifecycle hardening

## Problem

The release CLI launches the daemon supervisor through a background shell without creating a new session. The supervisor and daemon therefore remain in the launcher's process group and can both be terminated by process-group cleanup, bypassing the supervisor's shutdown and restart paths. Separately, the daemon child-process crash supervisor can construct a release invocation that the CLI entrypoint does not dispatch, leaving tracked children alive after an abrupt daemon exit.

## Scope

This change isolates the daemon supervisor from its launcher and makes the daemon child-process supervisor a supported hidden release entrypoint. It does not add a new watchdog, settings, or user-facing commands.

## Design

### Supervisor isolation

On Unix, the CLI launcher starts `daemon-supervisor` in a new session before returning its PID. The launcher remains non-blocking and keeps stdin/stdout detached as today. Windows continues using its existing detached spawn behavior.

The implementation exposes the Unix launcher argv construction as a pure function so tests can assert the session boundary without starting the user's daemon. Runtime readiness and PID-file behavior remain unchanged.

### Child-supervisor dispatch

The CLI bin entrypoint recognizes `--daemon-child-supervisor` before normal command parsing and delegates to the monad runtime's child-supervisor entrypoint. The runtime package exports that entrypoint from its public start surface, keeping registry parsing and process cleanup owned by `apps/monad`.

The child-supervisor argv builder continues to support source execution and compiled release execution. In a compiled release it targets the CLI executable, whose new hidden dispatch handles the invocation.

### Failure behavior

If session creation fails, daemon startup fails immediately instead of silently falling back to the vulnerable topology. Existing readiness timeout and supervisor logging report the launch failure. Child-supervisor parse or runtime failures preserve their existing non-zero exit behavior.

## Tests

- A CLI unit test proves the Unix launcher enters a new session and preserves the daemon-supervisor arguments and log redirection.
- A CLI bin dispatch test proves `--daemon-child-supervisor` is handled before the public CLI parser and forwards its arguments.
- Existing daemon child-process unit and Unix integration tests continue to prove argv construction and real child reaping after owner `SIGKILL`.
- Relevant CLI and daemon tests, lint, and typecheck run before completion.

## Success criteria

- The supervisor and daemon no longer inherit the launcher's process group on Unix.
- A compiled CLI invocation of `--daemon-child-supervisor <parentPid> <registryPath>` reaches the runtime supervisor.
- Normal start, restart, readiness, graceful shutdown, and both supported daemon transports remain behaviorally unchanged.

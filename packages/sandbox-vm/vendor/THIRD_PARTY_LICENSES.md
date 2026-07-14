# Third-party licenses — vendored binaries

This directory ships prebuilt binaries. Each is either built from monad's own
source (`packages/sandbox-vm/native/`) or from a pinned upstream module. Their
third-party dependencies and licenses are listed below. Rebuild with
`packages/sandbox-vm/native/winvm-helper/build.sh`.

## `gvforwarder-{amd64,arm64}`

Built from **[containers/gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock)**
`cmd/vm`, pinned at **v0.8.9**.

- License: **Apache License 2.0** — https://github.com/containers/gvisor-tap-vsock/blob/main/LICENSE
- Copyright the gvisor-tap-vsock authors.

## `winvm-helper-{amd64,arm64}.exe`

monad's own source (`native/winvm-helper/`), statically linked with:

| Module | Version | License |
| --- | --- | --- |
| github.com/containers/libhvee | v0.11.0 | Apache-2.0 |
| github.com/Microsoft/go-winio | v0.6.2 | MIT |
| github.com/hugelgupf/p9 | v0.4.1 | BSD-3-Clause |
| github.com/sirupsen/logrus | v1.9.4 | MIT |
| github.com/go-ole/go-ole | v1.3.0 | MIT |
| github.com/u-root/uio | (pinned) | BSD-3-Clause |
| go.podman.io/common | (pinned) | Apache-2.0 |
| golang.org/x/sys | v0.47.0 | BSD-3-Clause |

## `vsock-agent-{amd64,arm64}`

monad's own source (`native/vsock-agent/`), statically linked with:

| Module | Version | License |
| --- | --- | --- |
| golang.org/x/sys | v0.47.0 | BSD-3-Clause |

All licenses above (Apache-2.0, MIT, BSD-3-Clause) are compatible with monad's
MIT license. Apache-2.0 components require attribution, satisfied by this file.

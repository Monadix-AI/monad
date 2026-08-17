# Vendored binary supply chain

The VM backend needs guest and host binaries — a vsock agent inside the guest, a
seccomp observer, a gvproxy forwarder, and the Windows Hyper-V helper — that a
TypeScript workspace cannot produce at install time. This is how those bytes are
built, distributed, and verified, and how to reproduce them yourself.

## Where the bytes come from

Nothing is committed. `packages/sandbox-vm/vendor/*` is gitignored except
[THIRD_PARTY_LICENSES.md](../vendor/THIRD_PARTY_LICENSES.md); a rebuild never lands
a multi-megabyte blob in git history.

Each binary is published as a GitHub release asset on the `VENDOR_ASSET_RELEASE`
tag (`packages/sandbox-vm/src/vendor-assets.ts`) by
[`.github/workflows/vm-vendor-binaries.yml`](../../../.github/workflows/vm-vendor-binaries.yml).
The daemon downloads what it needs on demand into `<vmDir>/bin`.

Sources: `vsock-agent`, `seccomp-observer`, and `winvm-helper` are monad's own code
under [`packages/sandbox-vm/native/`](../native/); `gvforwarder` is built from a
pinned upstream commit of `containers/gvisor-tap-vsock`. Per-binary dependency and
license inventory is in [THIRD_PARTY_LICENSES.md](../vendor/THIRD_PARTY_LICENSES.md).

## Verification

Every asset that comes off the network is sha256-pinned in `vendor-assets.ts` and
**fails closed**: a digest that does not match the pin raises
`sha256 mismatch … refusing to run` instead of executing. A cached file is
re-digested before reuse, so a tampered cache is caught on the next resolve.

A binary you built locally is exempt, and deliberately so — it is your own artifact
and its digest legitimately differs until you re-pin. A local build always wins over
the download, which is what makes `native/` hackable without a release cycle.

## Reproducing a build

```bash
mise run vendor:vm -- --check     # what is present, and whether it matches the pins
mise run vendor:vm -- --build     # rebuild every asset from source (needs Go; gcc on Linux)
mise run vendor:vm:pins:own       # digest the local output against the pins, non-zero on drift
```

The build is expected to be byte-reproducible, and CI enforces that rather than
assuming it:

- The four Go binaries cross-compile from a single runner with `CGO_ENABLED=0` and
  explicit `GOOS`/`GOARCH`, so the host architecture cannot leak into the output.
- `seccomp-observer` is static C built per architecture inside the pinned
  `gcc:15-bookworm` image — a different compiler emits different bytes — and its
  build script runs a real self-test against the binary it just produced.
- [`sandbox-vm-native.yml`](../../../.github/workflows/sandbox-vm-native.yml)
  rebuilds the observer on pull requests and fails when the result does not match its
  pin, so a source change cannot land without re-pinning.
- The publish job re-runs the same check across all assets before uploading, and
  refuses a tag that does not equal `VENDOR_ASSET_RELEASE`. An unreproducible build
  cannot become a published asset.

## Bumping an asset

1. Change the source under [`native/`](../native/).
2. Rebuild: `mise run vendor:vm -- --build`.
3. Re-pin: `mise run vendor:vm:pins:own -- --write`.
4. Bump `VENDOR_ASSET_RELEASE` in `vendor-assets.ts` — an existing tag's assets are
   treated as immutable.
5. Push the matching `vm-vendor-v*` tag; the workflow verifies and publishes.

Update [THIRD_PARTY_LICENSES.md](../vendor/THIRD_PARTY_LICENSES.md) in the same change
whenever a dependency or its version moves.

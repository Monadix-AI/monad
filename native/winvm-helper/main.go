//go:build windows

// winvm-helper — the Windows host plane of @monad/sandbox-vm. Bun cannot speak WMI, AF_HYPERV, or
// Windows security descriptors, so every Hyper-V-specific primitive lives in this one vendored Go
// binary (mirroring how vfkit fronts Virtualization.framework on macOS):
//
//   probe                                       report Hyper-V/registry readiness as JSON
//   setup      --ports A,B-C[,…]                register hvsock service GUIDs (one-time, elevated)
//   create     --name N --cpus C --memory MB --disk X.vhdx
//   ignition   --name N --file ign.json         inject Ignition over Hyper-V KVP (split keys)
//   start|stop|remove|state --name N [--force] [--disk X]
//   execbridge --vm-id GUID --port P --pipe \\.\pipe\NAME
//                                               owner-only named pipe ⇄ guest vsock port (exec channel)
//   netbridge  --vm-id GUID --port P --connect-unix PATH
//                                               guest vsock port ⇄ gvproxy's AF_UNIX listener, pinned
//                                               to ONE VM (gvproxy's own hvsock listener would be
//                                               wildcard — any VM could reach any VM's egress stack)
//   serve9p    --vm-id GUID --port P --root DIR [--ro]
//                                               9p file server over hvsock, pinned to one VM
//
// Long-running commands (execbridge/netbridge/serve9p) print one JSON "ready" line to stdout, then
// serve until killed. Everything else prints one JSON result line and exits. Exit code 0/1.
//
// Build: scripts/build-winvm-helper.sh (GOOS=windows, both arches, vendored into
// packages/sandbox-vm/vendor/winvm-helper-<arch>.exe).

package main

import (
	"encoding/json"
	"fmt"
	"os"
)

func fail(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"error": msg})
	os.Exit(1)
}

func emit(v any) {
	_ = json.NewEncoder(os.Stdout).Encode(v)
}

func main() {
	if len(os.Args) < 2 {
		fail("usage: winvm-helper <probe|setup|create|ignition|start|stop|remove|state|execbridge|netbridge|serve9p> …")
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "probe":
		cmdProbe(args)
	case "setup":
		cmdSetup(args)
	case "create":
		cmdCreate(args)
	case "ignition":
		cmdIgnition(args)
	case "start", "stop", "remove", "state":
		cmdLifecycle(cmd, args)
	case "execbridge":
		cmdExecBridge(args)
	case "netbridge":
		cmdNetBridge(args)
	case "serve9p":
		cmdServe9p(args)
	default:
		fail("winvm-helper: unknown command %q", cmd)
	}
}

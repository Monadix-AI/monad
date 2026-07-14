//go:build windows

// hvsock service registration. Windows only routes an AF_HYPERV connection if the service GUID is
// registered under HKLM\...\GuestCommunicationServices — an elevated, one-time write. Rather than
// podman's random-port-per-machine approach (which needs admin on every machine create), monad
// registers a FIXED port range once (`msvm setup`); every VM reuses it, and per-VM isolation comes
// from binding each listener/dialer to a specific VMID, not from unique ports.

package main

import (
	"flag"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const vsockRegistryPath = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`

// The Microsoft-defined template mapping a 32-bit vsock port to an hvsock service GUID.
const linuxVmGuidSuffix = "FACB-11E6-BD58-64006A7986D3"

func portKeyName(port uint32) string {
	return fmt.Sprintf("%08X-%s", port, linuxVmGuidSuffix)
}

// parsePorts expands "1024,1026-1057" into the individual ports.
func parsePorts(spec string) ([]uint32, error) {
	var ports []uint32
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if lo, hi, ok := strings.Cut(part, "-"); ok {
			a, err1 := strconv.ParseUint(lo, 10, 32)
			b, err2 := strconv.ParseUint(hi, 10, 32)
			if err1 != nil || err2 != nil || b < a {
				return nil, fmt.Errorf("bad port range %q", part)
			}
			for p := a; p <= b; p++ {
				ports = append(ports, uint32(p))
			}
		} else {
			p, err := strconv.ParseUint(part, 10, 32)
			if err != nil {
				return nil, fmt.Errorf("bad port %q", part)
			}
			ports = append(ports, uint32(p))
		}
	}
	return ports, nil
}

func cmdSetup(args []string) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	portSpec := fs.String("ports", "", "comma/range list of vsock ports to register, e.g. 1024,1026-1057")
	check := fs.Bool("check", false, "only report which ports are registered (no writes, no admin)")
	_ = fs.Parse(args)
	ports, err := parsePorts(*portSpec)
	if err != nil || len(ports) == 0 {
		fail("setup: --ports is required: %v", err)
	}

	if *check {
		missing := []uint32{}
		for _, p := range ports {
			k, err := registry.OpenKey(registry.LOCAL_MACHINE, vsockRegistryPath+`\`+portKeyName(p), registry.QUERY_VALUE)
			if err != nil {
				missing = append(missing, p)
				continue
			}
			k.Close()
		}
		emit(map[string]any{"registered": len(missing) == 0, "missing": missing})
		return
	}

	parent, err := registry.OpenKey(registry.LOCAL_MACHINE, vsockRegistryPath, registry.CREATE_SUB_KEY)
	if err != nil {
		fail("setup: cannot open %s (requires an elevated shell): %v", vsockRegistryPath, err)
	}
	defer parent.Close()
	for _, p := range ports {
		k, _, err := registry.CreateKey(parent, portKeyName(p), registry.WRITE)
		if err != nil {
			fail("setup: creating key for port %d: %v", p, err)
		}
		// Purpose/ToolName mirror podman's convention so `Get-ChildItem` output is self-describing.
		_ = k.SetStringValue("Purpose", "MonadSandboxVm")
		_ = k.SetStringValue("ToolName", "monad")
		k.Close()
	}
	emit(map[string]any{"ok": true, "registered": len(ports)})
}

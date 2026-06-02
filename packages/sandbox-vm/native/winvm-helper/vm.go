//go:build windows

// Hyper-V VM lifecycle over WMI via containers/libhvee (the library podman machine's hyperv
// provider uses), plus Ignition injection over the Hyper-V KVP data exchange — the mechanism
// Fedora CoreOS's hyperv Ignition provider reads (split keys `ignition.config.0`, `.1`, …).

package main

import (
	"bytes"
	"flag"
	"os"

	"github.com/containers/libhvee/pkg/hypervctl"
)

// The KVP key prefix coreos/ignition's hyperv provider reassembles split configs from.
const ignitionKeyPrefix = "ignition.config."

func cmdProbe(args []string) {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	_ = fs.Parse(args)
	vmm := hypervctl.NewVirtualMachineManager()
	// Listing machines exercises the whole WMI path (namespace reachable + VMMS running + caller
	// authorized) — the authoritative "is Hyper-V usable for us" check.
	_, err := vmm.GetAll()
	if err != nil {
		emit(map[string]any{"hyperv": false, "detail": err.Error()})
		return
	}
	emit(map[string]any{"hyperv": true})
}

func cmdCreate(args []string) {
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	name := fs.String("name", "", "VM name")
	cpus := fs.Uint("cpus", 2, "vCPU count")
	memoryMiB := fs.Uint64("memory", 2048, "memory in MiB")
	disk := fs.String("disk", "", "path to the VM's vhdx (attached, not created)")
	_ = fs.Parse(args)
	if *name == "" || *disk == "" {
		fail("create: --name and --disk are required")
	}
	vmm := hypervctl.NewVirtualMachineManager()
	// A stale same-name VM (crashed daemon) must not shadow the new one: remove it first. If the
	// stale VM exists but can't be removed (stuck state), fail LOUDLY — proceeding to
	// NewVirtualMachine would either error cryptically or leave the stale VM shadowing the new one,
	// the exact case this guard exists to prevent.
	if exists, _ := vmm.Exists(*name); exists {
		vm, err := vmm.GetMachine(*name)
		if err != nil {
			fail("create: stale VM %q exists but is unreadable: %v", *name, err)
		}
		_ = vm.StopWithForce() // best-effort: already-stopped returns an error we don't care about
		if err := vm.Remove(""); err != nil {
			fail("create: could not remove stale VM %q: %v", *name, err)
		}
	}
	cfg := &hypervctl.HardwareConfig{
		CPUs:     uint16(*cpus),
		DiskPath: *disk,
		Memory:   *memoryMiB,
		Network:  false, // never a real Hyper-V NIC — guest networking is gvforwarder-over-hvsock
	}
	if err := vmm.NewVirtualMachine(*name, cfg); err != nil {
		fail("create: %v", err)
	}
	vm, err := vmm.GetMachine(*name)
	if err != nil {
		fail("create: created but not found: %v", err)
	}
	// Msvm_ComputerSystem.Name is the VM's GUID (ElementName is the friendly name) — the ID every
	// hvsock endpoint (execbridge/netbridge/serve9p) is pinned to.
	emit(map[string]string{"vmId": vm.Name})
}

func cmdIgnition(args []string) {
	fs := flag.NewFlagSet("ignition", flag.ExitOnError)
	name := fs.String("name", "", "VM name")
	file := fs.String("file", "", "Ignition JSON path")
	_ = fs.Parse(args)
	if *name == "" || *file == "" {
		fail("ignition: --name and --file are required")
	}
	data, err := os.ReadFile(*file)
	if err != nil {
		fail("ignition: %v", err)
	}
	vm, err := hypervctl.NewVirtualMachineManager().GetMachine(*name)
	if err != nil {
		fail("ignition: %v", err)
	}
	if err := vm.SplitAndAddIgnition(ignitionKeyPrefix, bytes.NewReader(data)); err != nil {
		fail("ignition: %v", err)
	}
	emit(map[string]bool{"ok": true})
}

func cmdLifecycle(cmd string, args []string) {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	name := fs.String("name", "", "VM name")
	disk := fs.String("disk", "", "remove: also delete this disk path")
	force := fs.Bool("force", false, "stop: hard power-off instead of a guest shutdown")
	_ = fs.Parse(args)
	if *name == "" {
		fail("%s: --name is required", cmd)
	}
	vmm := hypervctl.NewVirtualMachineManager()
	vm, err := vmm.GetMachine(*name)
	if err != nil {
		if cmd == "remove" { // removing a machine that's already gone is success
			emit(map[string]bool{"ok": true})
			return
		}
		fail("%s: %v", cmd, err)
	}
	switch cmd {
	case "start":
		err = vm.Start()
	case "stop":
		if *force {
			err = vm.StopWithForce()
		} else {
			err = vm.Stop()
		}
	case "remove":
		_ = vm.StopWithForce() // Remove requires the Disabled state
		err = vm.Remove(*disk)
	case "state":
		emit(map[string]any{"state": int(vm.State())})
		return
	}
	if err != nil {
		fail("%s: %v", cmd, err)
	}
	emit(map[string]bool{"ok": true})
}

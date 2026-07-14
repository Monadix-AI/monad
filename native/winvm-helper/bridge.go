//go:build windows

// The two byte-stream bridges between host sockets Bun can speak and hvsock endpoints it cannot:
//
//   execbridge: named pipe (owner-only DACL) → guest vsock port. Bun connect()s the pipe per exec;
//               each pipe connection dials the agent's vsock listener — exactly vfkit's `connect`
//               virtio-vsock mode, so the exec channel code upstream is unchanged.
//   netbridge:  guest vsock port → gvproxy's AF_UNIX listener. gvproxy's own hvsock listener would
//               be wildcard-VMID (any VM could tunnel through any VM's egress stack); this bridge
//               accepts only its --vm-id, closing that cross-VM hole.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"time"

	"github.com/Microsoft/go-winio"
	"github.com/Microsoft/go-winio/pkg/guid"
)

func hvsockAddr(vmId string, port uint32) (*winio.HvsockAddr, error) {
	id, err := guid.FromString(vmId)
	if err != nil {
		return nil, fmt.Errorf("bad --vm-id %q: %w", vmId, err)
	}
	// The all-zero GUID equals winio.HvsockGUIDWildcard() — a listener bound to it accepts ANY
	// partition, silently downgrading the per-VM isolation (registry.go) to none and failing OPEN.
	// Every real vm-id is a concrete VM GUID; reject the wildcard/zero value rather than trust it.
	if id == (guid.GUID{}) {
		return nil, fmt.Errorf("refusing wildcard/zero --vm-id %q (would accept any VM)", vmId)
	}
	return &winio.HvsockAddr{VMID: id, ServiceID: winio.VsockServiceID(port)}, nil
}

// ownerOnlySddl builds a DACL granting full access to SYSTEM and the current user only — the pipe
// is the VM's exec channel, so any-user access would be arbitrary code execution in the sandbox.
func ownerOnlySddl() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;%s)", u.Uid), nil
}

func pump(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); _ = a.Close(); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); _ = b.Close(); done <- struct{}{} }()
	<-done
	<-done
}

func cmdExecBridge(args []string) {
	fs := flag.NewFlagSet("execbridge", flag.ExitOnError)
	vmId := fs.String("vm-id", "", "target VM GUID")
	port := fs.Uint("port", 1024, "guest vsock port")
	pipe := fs.String("pipe", "", `named pipe path (\\.\pipe\…)`)
	_ = fs.Parse(args)
	if *vmId == "" || *pipe == "" {
		fail("execbridge: --vm-id and --pipe are required")
	}
	addr, err := hvsockAddr(*vmId, uint32(*port))
	if err != nil {
		fail("execbridge: %v", err)
	}
	sddl, err := ownerOnlySddl()
	if err != nil {
		fail("execbridge: resolving current user: %v", err)
	}
	l, err := winio.ListenPipe(*pipe, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		fail("execbridge: listen %s: %v", *pipe, err)
	}
	emit(map[string]any{"ready": true, "pipe": *pipe})
	acceptLoop("execbridge", l, func(host net.Conn) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		guest, err := winio.Dial(ctx, addr)
		if err != nil {
			_ = host.Close() // guest not up yet — the caller's readiness probe just retries
			return
		}
		pump(host, guest)
	})
}

// acceptLoop serves connections until the listener is permanently closed. A transient Accept error
// (momentary resource pressure) must NOT tear down the whole plane — this is the VM's only exec or
// egress channel, and os.Exit here would kill it for the VM's entire lifetime with no recovery. So
// log transient errors and retry with a short backoff; exit only when the listener is closed.
func acceptLoop(name string, l net.Listener, handle func(net.Conn)) {
	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"warn": fmt.Sprintf("%s: accept: %v", name, err)})
			time.Sleep(50 * time.Millisecond)
			continue
		}
		go handle(conn)
	}
}

func cmdNetBridge(args []string) {
	fs := flag.NewFlagSet("netbridge", flag.ExitOnError)
	vmId := fs.String("vm-id", "", "VM GUID allowed to connect")
	port := fs.Uint("port", 0, "vsock port the guest's gvforwarder dials")
	unixPath := fs.String("connect-unix", "", "gvproxy's AF_UNIX listener path")
	_ = fs.Parse(args)
	if *vmId == "" || *port == 0 || *unixPath == "" {
		fail("netbridge: --vm-id, --port and --connect-unix are required")
	}
	addr, err := hvsockAddr(*vmId, uint32(*port))
	if err != nil {
		fail("netbridge: %v", err)
	}
	// Listening on (VMID, port) — not the wildcard VMID — is the isolation boundary: only this VM's
	// gvforwarder can reach this VM's gvproxy.
	l, err := winio.ListenHvsock(addr)
	if err != nil {
		fail("netbridge: listen hvsock %s:%d: %v", *vmId, *port, err)
	}
	emit(map[string]any{"ready": true})
	acceptLoop("netbridge", l, func(g net.Conn) {
		host, err := net.DialTimeout("unix", *unixPath, 10*time.Second)
		if err != nil {
			_ = g.Close()
			return
		}
		pump(g, host)
	})
}

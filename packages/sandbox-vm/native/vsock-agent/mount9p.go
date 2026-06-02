// mount9p — the guest half of the Hyper-V mount plane. The host (winvm-helper serve9p) exposes one
// policy root per vsock port as a 9p file server pinned to this VM; this subcommand dials the port
// (CID 2 = the host) and mounts it with the kernel 9p client in trans=fd mode, passing the connected
// socket as the transport — the same mechanism as podman machine's client9p. Read-only roots are
// mounted `ro` here AND enforced host-side by the server (the mount flag is the belt, the server
// wrapper is the suspenders).

package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"time"

	"golang.org/x/sys/unix"
)

func mount9p(args []string) int {
	fs := flag.NewFlagSet("mount9p", flag.ContinueOnError)
	port := fs.Uint("port", 0, "host vsock port serving this share")
	target := fs.String("target", "", "guest mount point")
	ro := fs.Bool("ro", false, "mount read-only")
	if err := fs.Parse(args); err != nil || *port == 0 || *target == "" {
		fmt.Fprintln(os.Stderr, "usage: monad-vsock-agent mount9p -port N -target /path [-ro]")
		return 64
	}

	if err := os.MkdirAll(*target, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "mount9p mkdir:", err)
		return 1
	}

	// The host's 9p server starts before the VM boots, but retry anyway — systemd unit ordering
	// inside the guest says nothing about host-side readiness after a crash-restart.
	fd, err := dialHostVsock(uint32(*port), 20, 250*time.Millisecond)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mount9p dial:", err)
		return 1
	}

	opts := "trans=fd,rfdno=3,wfdno=3,version=9p2000.L"
	if *ro {
		opts += ",ro"
	}
	cmd := exec.Command("mount", "-t", "9p", "-o", opts, "9p", *target)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = []*os.File{os.NewFile(uintptr(fd), "9p-vsock")} // becomes fd 3 in the child
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "mount9p mount:", err)
		return 1
	}
	return 0
}

func dialHostVsock(port uint32, attempts int, delay time.Duration) (int, error) {
	var lastErr error
	for i := 0; i < attempts; i++ {
		fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
		if err != nil {
			return -1, err
		}
		if err := unix.Connect(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_HOST, Port: port}); err == nil {
			return fd, nil
		} else {
			lastErr = err
			_ = unix.Close(fd)
			time.Sleep(delay)
		}
	}
	return -1, fmt.Errorf("vsock port %d not reachable after %d attempts: %w", port, attempts, lastErr)
}

// monad-vsock-agent — the guest-side exec channel for the macOS VM sandbox. Runs inside the Fedora
// CoreOS guest, listens on an AF_VSOCK port, and executes one command per connection, multiplexing
// stdout/stderr/exit back to the host over the same connection. This replaces ssh: it is
// NIC-independent (vsock is a direct host↔guest transport), so net:'none' can drop the guest NIC
// entirely — the strongest isolation — while the control plane still works. The control plane is a
// vsock RPC channel, so the guest needs no network device to be driven.
//
// Wire protocol (all integers big-endian). The host sends exactly one request frame, then the agent
// streams response frames until an EXIT frame, then closes:
//
//	request  (host→guest): [len:u32][json]   json = {"argv":[...],"cwd":"...","env":{"K":"V"}}
//	response (guest→host): [channel:u8][len:u32][data]
//	                       channel 1 = stdout, 2 = stderr, 3 = exit (data = 4-byte exit code)
//
// Build (from the repo, run by native/vsock-agent/build.sh):
//
//	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o <out> .

package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// lookupMonad resolves the unprivileged guest user's uid/gid. Commands run under it, never root.
func lookupMonad() (uint32, uint32, bool) {
	u, err := user.Lookup("monad")
	if err != nil {
		return 0, 0, false
	}
	uid, err1 := strconv.ParseUint(u.Uid, 10, 32)
	gid, err2 := strconv.ParseUint(u.Gid, 10, 32)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return uint32(uid), uint32(gid), true
}

// The vsock port the agent listens on. The host wires vfkit's virtio-vsock device to this port.
const vsockPort = 1024

type request struct {
	Argv []string          `json:"argv"`
	Cwd  string            `json:"cwd"`
	Env  map[string]string `json:"env"`
}

const (
	chStdout = 1
	chStderr = 2
	chExit   = 3
)

func main() {
	// mount9p mode: mount a host 9p share served over vsock — the Hyper-V mount plane (no virtio-fs
	// on Windows hosts). Run by a per-mount Ignition oneshot unit as root, before the exec agent
	// starts. Same binary so the guest payload stays single-file.
	if len(os.Args) > 1 && os.Args[1] == "mount9p" {
		os.Exit(mount9p(os.Args[2:]))
	}
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "vsock socket:", err)
		os.Exit(1)
	}
	// Bind to (CID_ANY, vsockPort): accept host-initiated connections on this port.
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: vsockPort}); err != nil {
		fmt.Fprintln(os.Stderr, "vsock bind:", err)
		os.Exit(1)
	}
	if err := unix.Listen(fd, 16); err != nil {
		fmt.Fprintln(os.Stderr, "vsock listen:", err)
		os.Exit(1)
	}
	for {
		conn, _, err := unix.Accept(fd)
		if err != nil {
			continue
		}
		go handle(conn)
	}
}

func handle(fd int) {
	f := os.NewFile(uintptr(fd), "vsock-conn")
	defer f.Close()

	req, err := readRequest(f)
	if err != nil {
		writeExit(f, 127)
		return
	}
	writeExit(f, run(f, req))
}

func readRequest(f *os.File) (*request, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(f, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	body := make([]byte, n)
	if _, err := io.ReadFull(f, body); err != nil {
		return nil, err
	}
	var req request
	if err := json.Unmarshal(body, &req); err != nil {
		return nil, err
	}
	return &req, nil
}

func run(f *os.File, req *request) int {
	if len(req.Argv) == 0 {
		return 127
	}
	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Dir = req.Cwd
	// The agent runs as root (it binds vsock + is the trusted control broker), but the AGENT'S
	// COMMAND must run unprivileged: drop to the `monad` user so the sandboxed workload never has
	// root (mirrors sshd running as root but sessions as the user). Fail closed if monad is missing.
	uid, gid, ok := lookupMonad()
	if !ok {
		return 127
	}
	env := []string{"HOME=/home/monad", "USER=monad", "LOGNAME=monad", "PATH=/usr/local/bin:/usr/bin:/bin"}
	for k, v := range req.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 127
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 127
	}
	if err := cmd.Start(); err != nil {
		return 127
	}

	// Serialize frame writes across the two pump goroutines (frames must not interleave).
	var mu sync.Mutex
	var wg sync.WaitGroup
	pump := func(r io.Reader, ch byte) {
		defer wg.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				mu.Lock()
				writeFrame(f, ch, buf[:n])
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump(stdout, chStdout)
	go pump(stderr, chStderr)
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

func writeFrame(f *os.File, ch byte, data []byte) {
	var hdr [5]byte
	hdr[0] = ch
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(data)))
	f.Write(hdr[:])
	if len(data) > 0 {
		f.Write(data)
	}
}

func writeExit(f *os.File, code int) {
	var codeBuf [4]byte
	binary.BigEndian.PutUint32(codeBuf[:], uint32(code))
	writeFrame(f, chExit, codeBuf[:])
}

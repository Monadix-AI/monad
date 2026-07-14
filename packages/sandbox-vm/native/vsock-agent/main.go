// monad-vsock-agent — the guest-side exec channel for the macOS VM sandbox. Runs inside the Fedora
// CoreOS guest, listens on an AF_VSOCK port, and executes one command per connection, multiplexing
// stdout/stderr/exit back to the host over the same connection. This replaces ssh: it is
// NIC-independent (vsock is a direct host↔guest transport), so net:'none' can drop the guest NIC
// entirely — the strongest isolation — while the control plane still works. Mirrors Claude Cowork's
// coworkd/vsock RPC design.
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
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const vsockPort = 1024

var safeRunID = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

type managedRun struct {
	cmd           *exec.Cmd
	stdin         io.WriteCloser
	done          chan exitMessage
	terminateOnce sync.Once
}

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
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: vsockPort}); err != nil {
		fmt.Fprintln(os.Stderr, "vsock bind:", err)
		os.Exit(1)
	}
	if err := unix.Listen(fd, 16); err != nil {
		fmt.Fprintln(os.Stderr, "vsock listen:", err)
		os.Exit(1)
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		unix.Close(fd)
	}()
	for {
		conn, _, err := unix.Accept(fd)
		if err != nil {
			return
		}
		go serveConnection(os.NewFile(uintptr(conn), "vsock-conn"))
	}
}

func serveConnection(conn io.ReadWriteCloser) {
	defer conn.Close()
	first, err := readFrame(conn)
	if err != nil || first.Kind != frameStart {
		return
	}
	var req startRequest
	if json.Unmarshal(first.Payload, &req) != nil || validateStart(req) != nil {
		writer := &frameWriter{w: conn}
		writer.json(frameError, map[string]string{"message": "invalid start request"})
		return
	}
	cmd, err := commandFor(req)
	if err != nil {
		(&frameWriter{w: conn}).json(frameError, map[string]string{"message": err.Error()})
		return
	}
	writer := &frameWriter{w: conn}
	run, err := startCommand(cmd, func(kind byte, data []byte) { writer.write(kind, data) })
	if err != nil {
		writer.json(frameError, map[string]string{"message": err.Error()})
		return
	}
	writer.json(frameStarted, startedMessage{RunID: req.RunID, PID: run.cmd.Process.Pid})

	frames := make(chan wireFrame)
	readErrors := make(chan error, 1)
	go func() {
		defer close(frames)
		for {
			frame, err := readFrame(conn)
			if err != nil {
				readErrors <- err
				return
			}
			frames <- frame
		}
	}()

	grace := time.Duration(req.Limits.TerminateGraceMs) * time.Millisecond
	if grace <= 0 {
		grace = 2 * time.Second
	}
	for {
		select {
		case result := <-run.done:
			writer.json(frameExit, result)
			return
		case <-readErrors:
			run.terminate(grace)
			<-run.done
			return
		case frame, ok := <-frames:
			if !ok {
				run.terminate(grace)
				<-run.done
				return
			}
			handleControl(run, writer, frame)
		}
	}
}

func validateStart(req startRequest) error {
	if req.Version != protocolVersion {
		return fmt.Errorf("unsupported protocol version")
	}
	if !safeRunID.MatchString(req.RunID) {
		return fmt.Errorf("invalid run id")
	}
	if len(req.Argv) == 0 || req.Argv[0] == "" {
		return fmt.Errorf("argv is empty")
	}
	return nil
}

func handleControl(run *managedRun, writer *frameWriter, frame wireFrame) {
	switch frame.Kind {
	case frameStdin:
		if run.stdin != nil {
			run.stdin.Write(frame.Payload)
		}
	case frameCloseStdin:
		if run.stdin != nil {
			run.stdin.Close()
		}
	case frameSignal:
		var req signalRequest
		if json.Unmarshal(frame.Payload, &req) == nil && req.Signal >= 1 && req.Signal <= 64 {
			run.signal(syscall.Signal(req.Signal))
		}
	case frameResize:
		writer.json(frameUnsupported, map[string]string{"operation": "resize"})
	}
}

func commandFor(req startRequest) (*exec.Cmd, error) {
	uid, gid, ok := lookupMonad()
	if !ok {
		return nil, fmt.Errorf("monad user is unavailable")
	}
	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Dir = req.Cwd
	cmd.Env = []string{"HOME=/home/monad", "USER=monad", "LOGNAME=monad", "PATH=/usr/local/bin:/usr/bin:/bin"}
	for key, value := range req.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}}
	return cmd, nil
}

func lookupMonad() (uint32, uint32, bool) {
	u, err := user.Lookup("monad")
	if err != nil {
		return 0, 0, false
	}
	uid, errUID := strconv.ParseUint(u.Uid, 10, 32)
	gid, errGID := strconv.ParseUint(u.Gid, 10, 32)
	if errUID != nil || errGID != nil {
		return 0, 0, false
	}
	return uint32(uid), uint32(gid), true
}

func startCommand(cmd *exec.Cmd, output func(byte, []byte)) (*managedRun, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	run := &managedRun{cmd: cmd, stdin: stdin, done: make(chan exitMessage, 1)}
	var pumps sync.WaitGroup
	pump := func(reader io.Reader, kind byte) {
		defer pumps.Done()
		buf := make([]byte, 32*1024)
		for {
			n, err := reader.Read(buf)
			if n > 0 && output != nil {
				output(kind, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}
	pumps.Add(2)
	go pump(stdout, frameStdout)
	go pump(stderr, frameStderr)
	go func() {
		err := cmd.Wait()
		pumps.Wait()
		run.done <- exitResult(cmd, err)
	}()
	return run, nil
}

func exitResult(cmd *exec.Cmd, err error) exitMessage {
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return exitMessage{Code: nil, Signal: int(status.Signal())}
	}
	code := 0
	if err != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return exitMessage{Code: &code}
}

func (run *managedRun) signal(sig syscall.Signal) {
	if run.cmd.Process != nil {
		syscall.Kill(-run.cmd.Process.Pid, sig)
	}
}

func (run *managedRun) terminate(grace time.Duration) {
	run.terminateOnce.Do(func() {
		run.signal(syscall.SIGTERM)
		time.AfterFunc(grace, func() {
			if run.cmd.ProcessState == nil {
				run.signal(syscall.SIGKILL)
			}
		})
	})
}

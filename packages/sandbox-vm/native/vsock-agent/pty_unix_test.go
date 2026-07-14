//go:build linux || darwin

package main

import (
	"bytes"
	"io"
	"os/exec"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestPTYAppliesInitialAndUpdatedWindowSize(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 60")
	master, err := startPTY(cmd, terminalOptions{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
	}()

	initial, err := unix.IoctlGetWinsize(int(master.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Col != 80 || initial.Row != 24 {
		t.Fatalf("initial size = %dx%d", initial.Col, initial.Row)
	}
	if err := resizePTY(master, resizeRequest{Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	updated, err := unix.IoctlGetWinsize(int(master.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Col != 120 || updated.Row != 40 {
		t.Fatalf("updated size = %dx%d", updated.Col, updated.Row)
	}
}

func TestPTYCombinesStdoutAndStderr(t *testing.T) {
	cmd := exec.Command("sh", "-c", "printf stdout; printf stderr >&2")
	master, err := startPTY(cmd, terminalOptions{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	drained := make(chan struct{})
	go func() {
		io.Copy(&output, master)
		close(drained)
	}()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	master.Close()
	<-drained
	text := output.String()
	if !strings.Contains(text, "stdout") || !strings.Contains(text, "stderr") {
		t.Fatalf("combined output %q", text)
	}
}

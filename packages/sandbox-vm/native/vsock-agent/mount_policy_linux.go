//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const emptyDenyFile = "/run/monad/empty/deny"

func defaultMountOperations() mountOperations {
	return mountOperations{
		bindReadOnly:  bindReadOnly,
		denyDirectory: denyDirectory,
		denyFile:      denyFile,
	}
}

func bindReadOnly(source, target string) error {
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.MkdirAll(target, 0o755); err != nil {
			return err
		}
	} else if info.Mode().IsRegular() {
		if err := ensureFile(target); err != nil {
			return err
		}
	} else {
		return fmt.Errorf("source is not a regular file or directory")
	}
	if err := unix.Mount(source, target, "", unix.MS_BIND, ""); err != nil {
		return err
	}
	return unix.Mount("", target, "", unix.MS_BIND|unix.MS_REMOUNT|unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, "")
}

func denyDirectory(target string) error {
	if err := os.MkdirAll(target, 0o000); err != nil {
		return err
	}
	return unix.Mount(
		"tmpfs",
		target,
		"tmpfs",
		unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC,
		"size=4k,mode=000",
	)
}

func denyFile(target string) error {
	if err := ensureFile(emptyDenyFile); err != nil {
		return err
	}
	if err := os.Chmod(emptyDenyFile, 0o000); err != nil {
		return err
	}
	return bindReadOnly(emptyDenyFile, target)
}

func ensureFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("target is not a regular file")
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	return file.Close()
}

//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

const baselineMarker = ".monad-baseline"

func psQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func encodedPowerShell(script string) string {
	units := utf16.Encode([]rune(script))
	encoded := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(encoded[i*2:], unit)
	}
	return base64.StdEncoding.EncodeToString(encoded)
}

func runPowerShell(script string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script))
	var output bytes.Buffer
	cmd.Stdout = &limitedWriter{writer: &output, remaining: 1024 * 1024}
	cmd.Stderr = &limitedWriter{writer: &output, remaining: 1024 * 1024}
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("PowerShell failed: %w: %s", err, strings.TrimSpace(output.String()))
	}
	var result map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &result); err != nil {
		return nil, fmt.Errorf("PowerShell returned invalid JSON")
	}
	return result, nil
}

type limitedWriter struct {
	writer    *bytes.Buffer
	remaining int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if len(p) > w.remaining {
		return 0, fmt.Errorf("output limit exceeded")
	}
	w.remaining -= len(p)
	return w.writer.Write(p)
}

func baselinePath(raw string, create bool) (string, error) {
	if raw == "" || !filepath.IsAbs(raw) {
		return "", fmt.Errorf("--path must be absolute")
	}
	clean := filepath.Clean(raw)
	if create {
		if err := os.MkdirAll(clean, 0700); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(clean, baselineMarker), []byte("monad-vm-baseline\n"), 0600); err != nil {
			return "", err
		}
	}
	marker, err := os.ReadFile(filepath.Join(clean, baselineMarker))
	if err != nil || string(marker) != "monad-vm-baseline\n" {
		return "", fmt.Errorf("path is not a marker-owned Monad baseline")
	}
	return clean, nil
}

func cmdBaseline(command string, args []string) {
	fs := flag.NewFlagSet(command, flag.ExitOnError)
	name := fs.String("name", "", "VM name")
	path := fs.String("path", "", "marker-owned baseline directory")
	_ = fs.Parse(args)
	create := command == "baseline-create"
	dir, err := baselinePath(*path, create)
	if err != nil {
		fail("%s: %v", command, err)
	}
	switch command {
	case "baseline-create":
		if *name == "" {
			fail("baseline-create: --name is required")
		}
		exportDir := filepath.Join(dir, "export")
		script := fmt.Sprintf(
			"$ErrorActionPreference='Stop'; Set-VM -Name %s -CheckpointType Standard; "+
				"$s=Checkpoint-VM -Name %s -SnapshotName ('monad-baseline-'+[guid]::NewGuid()) -Passthru; "+
				"Export-VMSnapshot -VMSnapshot $s -Path %s; $id=$s.Id.Guid; Remove-VMSnapshot -VMSnapshot $s; "+
				"@{ok=$true;checkpointId=$id}|ConvertTo-Json -Compress",
			psQuote(*name), psQuote(*name), psQuote(exportDir),
		)
		result, err := runPowerShell(script)
		if err != nil {
			fail("baseline-create: %v", err)
		}
		emit(result)
	case "baseline-restore":
		if *name == "" {
			fail("baseline-restore: --name is required")
		}
		script := fmt.Sprintf(
			"$ErrorActionPreference='Stop'; $existing=Get-VM -Name %s -ErrorAction SilentlyContinue; if($existing){Stop-VM $existing -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM $existing -Force}; "+
				"$config=(Get-ChildItem -Path %s -Recurse -Filter *.vmcx|Select-Object -First 1).FullName; if(!$config){throw 'no vmcx in baseline'}; "+
				"$vm=Import-VM -Path $config -Copy -GenerateNewId; Rename-VM -VM $vm -NewName %s; @{ok=$true;vmId=$vm.Id.Guid}|ConvertTo-Json -Compress",
			psQuote(*name), psQuote(filepath.Join(dir, "export")), psQuote(*name),
		)
		result, err := runPowerShell(script)
		if err != nil {
			fail("baseline-restore: %v", err)
		}
		emit(result)
	case "baseline-inspect":
		var files int
		var bytes int64
		err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				files++
				bytes += info.Size()
			}
			return nil
		})
		if err != nil {
			fail("baseline-inspect: %v", err)
		}
		emit(map[string]any{"ok": true, "files": files, "bytes": bytes})
	case "baseline-delete":
		if err := os.RemoveAll(dir); err != nil {
			fail("baseline-delete: %v", err)
		}
		emit(map[string]bool{"ok": true})
	}
}

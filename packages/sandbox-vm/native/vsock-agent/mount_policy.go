package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

type mountOverlay struct {
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
	Target string `json:"target"`
}

type mountPolicy struct {
	Overlays []mountOverlay `json:"overlays"`
}

type mountOperations struct {
	bindReadOnly  func(source, target string) error
	denyDirectory func(target string) error
	denyFile      func(target string) error
}

func applyMountPolicy(policy mountPolicy, operations mountOperations) error {
	for _, overlay := range policy.Overlays {
		if !filepath.IsAbs(overlay.Target) {
			return fmt.Errorf("mount-policy: target must be absolute")
		}
		switch overlay.Kind {
		case "protect-store", "mask-file":
			if !filepath.IsAbs(overlay.Source) {
				return fmt.Errorf("mount-policy: source must be absolute")
			}
			if err := operations.bindReadOnly(overlay.Source, overlay.Target); err != nil {
				return fmt.Errorf("mount-policy: %s: %w", overlay.Kind, err)
			}
		case "deny-directory":
			if err := operations.denyDirectory(overlay.Target); err != nil {
				return fmt.Errorf("mount-policy: deny-directory: %w", err)
			}
		case "deny-file":
			if err := operations.denyFile(overlay.Target); err != nil {
				return fmt.Errorf("mount-policy: deny-file: %w", err)
			}
		default:
			return fmt.Errorf("mount-policy: unsupported overlay kind %q", overlay.Kind)
		}
	}
	return nil
}

func runMountPolicy(args []string) int {
	flags := flag.NewFlagSet("mount-policy", flag.ContinueOnError)
	configPath := flags.String("config", "", "mount policy JSON")
	if flags.Parse(args) != nil || *configPath == "" {
		return 2
	}
	config, err := os.Open(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "mount-policy:", err)
		return 1
	}
	defer config.Close()
	var policy mountPolicy
	if err := json.NewDecoder(config).Decode(&policy); err != nil {
		fmt.Fprintln(os.Stderr, "mount-policy:", err)
		return 1
	}
	if err := applyMountPolicy(policy, defaultMountOperations()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

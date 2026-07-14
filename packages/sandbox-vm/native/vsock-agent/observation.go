package main

import (
	"path"
	"strings"
)

const (
	maxObservationRoots  = 256
	maxObservationEvents = 256
	maxObservationText   = 4096
)

type observationPolicy struct {
	WritableRoots []string `json:"writableRoots,omitempty"`
	NoWriteRoots  []string `json:"noWriteRoots,omitempty"`
}

func underPath(target, root string) bool {
	return target == root || strings.HasPrefix(target, strings.TrimSuffix(root, "/")+"/")
}

func classifyObservedPath(
	policy observationPolicy,
	operation string,
	target string,
	pid int,
	runID string,
) *violationMessage {
	if target == "" || !strings.HasPrefix(target, "/") || len([]byte(target)) > maxObservationText {
		return nil
	}
	normalized := path.Clean(target)
	if !strings.HasPrefix(normalized, "/") {
		return nil
	}
	for _, root := range policy.NoWriteRoots {
		if underPath(normalized, root) {
			return &violationMessage{
				Kind: "filesystem", Operation: operation, RunID: runID, Target: normalized, PID: pid,
			}
		}
	}
	for _, root := range policy.WritableRoots {
		if underPath(normalized, root) {
			return nil
		}
	}
	return &violationMessage{Kind: "filesystem", Operation: operation, RunID: runID, Target: normalized, PID: pid}
}

type observationLimiter struct {
	runID        string
	limit        int
	seen         map[string]struct{}
	limitEmitted bool
}

func newObservationLimiter(runID string, limit int) *observationLimiter {
	if limit <= 0 {
		limit = maxObservationEvents
	}
	return &observationLimiter{runID: runID, limit: limit, seen: make(map[string]struct{}, limit)}
}

func (limiter *observationLimiter) admit(violation violationMessage) []violationMessage {
	key := violation.Operation + "\x00" + violation.Target
	if _, exists := limiter.seen[key]; exists {
		return nil
	}
	if len(limiter.seen) >= limiter.limit {
		if limiter.limitEmitted {
			return nil
		}
		limiter.limitEmitted = true
		return []violationMessage{{
			Kind: "runtime", Operation: "violation-limit", RunID: limiter.runID,
			Detail: "filesystem observation limit reached",
		}}
	}
	limiter.seen[key] = struct{}{}
	return []violationMessage{violation}
}

func validObservationPolicy(policy observationPolicy) bool {
	if len(policy.WritableRoots) > maxObservationRoots || len(policy.NoWriteRoots) > maxObservationRoots {
		return false
	}
	for _, roots := range [][]string{policy.WritableRoots, policy.NoWriteRoots} {
		for _, root := range roots {
			if root == "" || !strings.HasPrefix(root, "/") || path.Clean(root) != root || len([]byte(root)) > maxObservationText {
				return false
			}
		}
	}
	return true
}

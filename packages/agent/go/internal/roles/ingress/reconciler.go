package ingress

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RunReconciler retries durable ingress intent after failed writes/reloads.
func (h *Handler) RunReconciler(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		h.Reconcile()
	}
}

// Reconcile repairs the crash gap between durable sidecars, generated files and
// proxy reloads. Sidecars are authoritative, including deletion tombstones.
func (h *Handler) Reconcile() {
	h.mutationMu.Lock()
	defer h.mutationMu.Unlock()
	d, ok := h.driver.(*CaddyDriver)
	if !ok {
		return
	}
	paths, err := filepath.Glob(filepath.Join(d.configDir, "*--*.state.json"))
	if err != nil {
		h.logger.Error("ingress recovery scan failed", "error", err)
		return
	}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			h.logger.Error("ingress recovery state unreadable", "error", err)
			continue
		}
		var state appIngressState
		if err = json.Unmarshal(raw, &state); err != nil {
			h.logger.Error("ingress recovery state invalid", "error", err)
			continue
		}
		client, app := state.Client, state.App
		// Never derive ambiguous namespaces by splitting client--app filenames.
		// Refuse traversal and require metadata to map back to this exact sidecar.
		if !safeRecoveryClient(client) || !isValidAppName(app) || d.statePath(client, app) != path {
			h.logger.Error("ingress recovery namespace invalid", "path", path)
			continue
		}
		if !state.Stopped && !state.Deleted {
			if h.clientStore == nil {
				continue
			}
			policy := h.clientStore.Get(client)
			if policy == nil || policy.Ingress == nil {
				continue
			}
			if len(h.validateRoutes(state.Routes, policy.Ingress, client, app)) > 0 {
				h.logger.Error("ingress recovery rejected by policy", "client", client, "app", app)
				continue
			}
			if err = d.ValidateRoutes(state.Routes); err != nil {
				continue
			}
			h.injectDefaults(state.Routes, policy.Ingress)
		}
		before, _ := os.ReadFile(d.configPath(client, app))
		if state.Deleted {
			err = d.removeConfigFiles(client, app)
		} else {
			err = d.renderConfig(client, app, state.Routes, state.Stopped)
		}
		if err != nil {
			h.recoveryDirty = true
			h.logger.Error("ingress recovery render failed", "error", err)
			continue
		}
		after, _ := os.ReadFile(d.configPath(client, app))
		if !bytes.Equal(before, after) {
			h.recoveryDirty = true
		}
	}
	if h.recoveryDirty {
		if err = d.Reload(); err != nil {
			h.logger.Error("ingress recovery reload failed", "error", err)
			return
		}
		h.recoveryDirty = false
	}
}

// Client policies historically accept names beyond app slug syntax. Recovery
// only requires a single safe filesystem component, not a narrower new policy.
func safeRecoveryClient(client string) bool {
	return client != "" && client != "." && client != ".." && filepath.Base(client) == client && !strings.ContainsAny(client, "/\\") && !strings.ContainsRune(client, 0)
}

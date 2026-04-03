package compose

import (
	"crypto/sha256"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/opsen/agent/internal/config"
)

// Reconciler watches for client policy changes and redeploys affected projects.
type Reconciler struct {
	cfg         *config.AgentConfig
	clientStore *config.ClientStore
	tracker     *ResourceTracker
	ports       *PortAllocator
	logger      *slog.Logger
}

func NewReconciler(cfg *config.AgentConfig, clientStore *config.ClientStore, tracker *ResourceTracker, ports *PortAllocator, logger *slog.Logger) *Reconciler {
	return &Reconciler{cfg: cfg, clientStore: clientStore, tracker: tracker, ports: ports, logger: logger}
}

// Run starts the reconciliation loop. It checks for policy changes every interval
// and redeploys projects whose policy hash has changed.
func (r *Reconciler) Run(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for range ticker.C {
		r.reconcile()
	}
}

func (r *Reconciler) reconcile() {
	r.tracker.mu.RLock()
	clientNames := make([]string, 0, len(r.tracker.Clients))
	for name := range r.tracker.Clients {
		clientNames = append(clientNames, name)
	}
	r.tracker.mu.RUnlock()

	for _, clientName := range clientNames {
		client := r.clientStore.Get(clientName)
		if client == nil || client.Compose == nil {
			continue
		}

		currentHash := policyHash(client, r.cfg)

		r.tracker.mu.RLock()
		clientRes := r.tracker.Clients[clientName]
		if clientRes == nil {
			r.tracker.mu.RUnlock()
			continue
		}
		// Collect projects needing redeploy
		var stale []string
		for projectSlug, res := range clientRes.Projects {
			if res.PolicyHash != currentHash {
				stale = append(stale, projectSlug)
			}
		}
		r.tracker.mu.RUnlock()

		for _, projectSlug := range stale {
			r.redeployProject(clientName, client, projectSlug, currentHash)
		}
	}
}

func (r *Reconciler) redeployProject(clientName string, client *config.ClientPolicy, projectSlug, newHash string) {
	projectDir := filepath.Join(r.cfg.Roles.Compose.DeploymentsDir, clientName, projectSlug)
	composePath := findComposeFileOnDisk(projectDir)
	if composePath == "" {
		r.logger.Warn("reconcile: no compose file on disk, skipping", "client", clientName, "project", projectSlug)
		return
	}

	data, err := os.ReadFile(composePath)
	if err != nil {
		r.logger.Error("reconcile: failed to read compose file", "client", clientName, "project", projectSlug, "error", err)
		return
	}

	composeFile, err := parseCompose(data)
	if err != nil {
		r.logger.Error("reconcile: failed to parse compose file", "client", clientName, "project", projectSlug, "error", err)
		return
	}

	// Re-allocate ports (expose entries were cleared by previous hardening,
	// but port allocator has the existing mappings)
	var portMappings []PortMapping
	if r.ports != nil {
		pp := r.ports.GetProject(clientName, projectSlug)
		if pp != nil {
			portMappings = pp.Ports
		}
	}

	// Re-harden with current policy
	hardenCompose(composeFile, r.cfg, client, portMappings)

	// Write hardened compose file
	transformed, err := marshalCompose(composeFile)
	if err != nil {
		r.logger.Error("reconcile: failed to serialize compose file", "client", clientName, "project", projectSlug, "error", err)
		return
	}
	if err := os.WriteFile(composePath, transformed, 0640); err != nil {
		r.logger.Error("reconcile: failed to write compose file", "client", clientName, "project", projectSlug, "error", err)
		return
	}

	// Run docker compose up
	projectName := fmt.Sprintf("opsen-%s-%s", clientName, projectSlug)
	composeBin := r.cfg.Roles.Compose.ComposeBinary
	if err := composeUp(composeBin, projectName, composePath); err != nil {
		r.logger.Error("reconcile: compose up failed", "client", clientName, "project", projectSlug, "error", err)
		return
	}

	// Update the stored policy hash
	r.tracker.mu.Lock()
	if clientRes, ok := r.tracker.Clients[clientName]; ok {
		if res, ok := clientRes.Projects[projectSlug]; ok {
			res.PolicyHash = newHash
		}
	}
	r.tracker.save()
	r.tracker.mu.Unlock()

	r.logger.Info("reconcile: redeployed project with updated policy", "client", clientName, "project", projectSlug)
}

// policyHash computes a hash of the policy and config fields that affect compose deployments.
// If this hash changes, existing deployments need to be re-hardened.
func policyHash(client *config.ClientPolicy, cfg *config.AgentConfig) string {
	h := sha256.New()

	// Client compose policy fields
	if client.Compose != nil {
		fmt.Fprintf(h, "bind=%s\n", client.Compose.Network.IngressBindAddress)
		fmt.Fprintf(h, "internet=%v\n", client.Compose.Network.InternetAccess)
		fmt.Fprintf(h, "defaultmem=%d\n", client.Compose.PerContainer.DefaultMemoryMb)
		fmt.Fprintf(h, "maxpids=%d\n", client.Compose.PerContainer.MaxPids)
	}

	// Global hardening fields
	gh := cfg.GlobalHardening
	fmt.Fprintf(h, "nonewpriv=%v\n", gh.NoNewPrivileges)
	fmt.Fprintf(h, "capdropall=%v\n", gh.CapDropAll)
	fmt.Fprintf(h, "readonly=%v\n", gh.ReadOnlyRootfs)
	fmt.Fprintf(h, "defaultuser=%s\n", gh.DefaultUser)
	fmt.Fprintf(h, "pidlimit=%d\n", gh.PidLimit)
	for _, t := range gh.DefaultTmpfs {
		fmt.Fprintf(h, "tmpfs=%s:%s\n", t.Path, t.Options)
	}

	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

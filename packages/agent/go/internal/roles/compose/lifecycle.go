package compose

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

const managedComposeFile = ".opsen-compose.yml"
const activeComposeFile = ".opsen-active-compose.yml"

const sourceComposeFile = ".opsen-source-compose.yml"
const stoppedComposeFile = ".opsen-stopped-compose.yml"

type LifecycleResponse struct {
	Status  string `json:"status"`
	Project string `json:"project"`
	Stopped bool   `json:"stopped"`
}

func (h *Handler) Stop(w http.ResponseWriter, r *http.Request)  { h.lifecycle(w, r, true) }
func (h *Handler) Start(w http.ResponseWriter, r *http.Request) { h.lifecycle(w, r, false) }

func (h *Handler) lifecycle(w http.ResponseWriter, r *http.Request, stop bool) {
	client := identity.ClientFromContext(r.Context())
	if client.Compose == nil {
		writeJSON(w, 403, map[string]string{"error": "compose role not allowed for this client"})
		return
	}
	slug := requireProjectSlug(w, r)
	if slug == "" {
		return
	}
	unlock := h.tracker.lockClient(client.Client)
	defer unlock()
	if h.tracker.loadErr != nil {
		writeJSON(w, 500, map[string]string{"error": "resource state unavailable"})
		return
	}
	projectDir := filepath.Join(h.cfg.Roles.Compose.DeploymentsDir, client.Client, slug)
	composePath := findComposeFileOnDisk(projectDir)
	resources := h.tracker.GetProject(client.Client, slug)
	if composePath == "" || resources == nil {
		writeJSON(w, 404, map[string]string{"error": "no deployment found"})
		return
	}
	project := fmt.Sprintf("opsen-%s-%s", client.Client, slug)
	if stop {
		// Persist intent BEFORE stopping. A failed Docker request remains retryable
		// and policy reconciliation cannot inadvertently restart the project.
		if !resources.Stopped {
			data, err := os.ReadFile(composePath)
			if err != nil {
				writeJSON(w, 500, map[string]string{"error": "failed to read active deployment"})
				return
			}
			if err = writeProjectFile(filepath.Join(projectDir, stoppedComposeFile), data, composeFileMode); err != nil {
				writeJSON(w, 500, map[string]string{"error": "failed to retain active deployment"})
				return
			}
		}
		resources.Stopped = true
		if err := h.tracker.Set(client.Client, slug, resources); err != nil {
			writeJSON(w, 500, map[string]string{"error": "failed to persist stopped state"})
			return
		}
		if err := composeStopProject(h.cfg.Roles.Compose.ComposeBinary, project, composePath); err != nil {
			writeJSON(w, 500, map[string]string{"error": fmt.Sprintf("stop failed: %v", err)})
			return
		}
	} else {
		wasStopped := resources.Stopped
		// Older agents did not retain which filename was last deployed. Refuse
		// to guess when multiple legacy files remain; a new PUT canonicalizes it.
		if filepath.Base(composePath) != managedComposeFile {
			legacyFiles := 0
			for _, name := range []string{"compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"} {
				if _, err := os.Stat(filepath.Join(projectDir, name)); err == nil {
					legacyFiles++
				}
			}
			if legacyFiles > 1 {
				writeJSON(w, 409, map[string]string{"error": "ambiguous legacy compose files; PUT the deployment before starting"})
				return
			}
		}
		if resources.PendingInvalid {
			writeJSON(w, 409, map[string]string{"error": "last deferred deployment failed; redeploy successfully before starting"})
			return
		}
		currentHash := policyHash(client, h.cfg)
		// Always validate the retained original input against the CURRENT policy,
		// even when unchanged containers can be started without recreation.
		requested, err := h.prepareStart(client, slug, projectDir, composePath)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("start rejected: %v", err)})
			return
		}
		resources.Containers, resources.MemoryMb, resources.Cpus = requested.Containers, requested.MemoryMb, requested.Cpus
		if err := h.tracker.CheckBudget(client.Client, slug, client.Compose, resources); err != nil {
			writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("resource budget exceeded: %v", err)})
			return
		}
		// Compose up is idempotent for unchanged configurations (retaining IDs),
		// recreates only changed services and also restores externally missing ones.
		err = composeUp(h.cfg.Roles.Compose.ComposeBinary, project, composePath)
		if err != nil {
			// Partial start must not leave a project running while its durable state
			// still says stopped. Best effort stop; report both failures if necessary.
			var stopErr error
			if wasStopped {
				stopErr = composeStopProject(h.cfg.Roles.Compose.ComposeBinary, project, composePath)
			}
			writeJSON(w, 500, map[string]string{"error": fmt.Sprintf("start failed: %v; rollback stop: %v", err, stopErr)})
			return
		}
		if err := copyComposeFile(composePath, filepath.Join(projectDir, activeComposeFile)); err != nil {
			var stopErr error
			if wasStopped {
				stopErr = composeStopProject(h.cfg.Roles.Compose.ComposeBinary, project, composePath)
			}
			writeJSON(w, 500, map[string]string{"error": fmt.Sprintf("failed to persist active configuration: %v; rollback stop: %v", err, stopErr)})
			return
		}
		resources.Stopped = false
		resources.PendingApply = false
		resources.PolicyHash = currentHash
		if err := h.tracker.Set(client.Client, slug, resources); err != nil {
			var stopErr error
			if wasStopped {
				stopErr = composeStopProject(h.cfg.Roles.Compose.ComposeBinary, project, composePath)
			}
			writeJSON(w, 500, map[string]string{"error": fmt.Sprintf("failed to persist started state: %v; rollback stop: %v", err, stopErr)})
			return
		}
	}
	status := "started"
	if stop {
		status = "stopped"
	}
	writeJSON(w, 200, LifecycleResponse{Status: status, Project: project, Stopped: stop})
}

func (h *Handler) prepareStart(client *config.ClientPolicy, slug, projectDir, composePath string) (*ProjectResources, error) {
	data, err := os.ReadFile(filepath.Join(projectDir, sourceComposeFile))
	legacy := os.IsNotExist(err)
	if legacy {
		data, err = os.ReadFile(composePath)
	}
	if err != nil {
		return nil, err
	}
	parsed, err := parseCompose(data)
	if err != nil {
		return nil, err
	}
	// Legacy deployments predate retained inputs. Strip only helpers carrying
	// BOTH reserved agent markers before validating and regenerating them.
	if legacy {
		removed := map[string]bool{}
		for name, svc := range parsed.Services {
			if isGeneratedChownSidecar(name, svc) {
				delete(parsed.Services, name)
				removed[name] = true
			}
		}
		for _, svc := range parsed.Services {
			svc.DependsOn = stripDependenciesOn(svc.DependsOn, removed)
		}
	}
	if violations := validateCompose(parsed, h.cfg, client.Compose, projectDir); len(violations) > 0 {
		return nil, fmt.Errorf("policy violations: %s", strings.Join(violations, "; "))
	}
	requested := calculateResources(parsed, client.Compose)
	var mappings []PortMapping
	if h.ports != nil {
		if pp := h.ports.GetProject(client.Client, slug); pp != nil {
			mappings = pp.Ports
		}
	}
	hardenCompose(parsed, h.cfg, client, slug, mappings)
	data, err = marshalCompose(parsed)
	if err != nil {
		return nil, err
	}
	return requested, writeProjectFile(composePath, data, composeFileMode)
}

func composeAction(binary, project, composePath, action string) error {
	parts := strings.Fields(binary)
	if len(parts) == 0 {
		return fmt.Errorf("compose binary is not configured")
	}
	args := append(parts[1:], "-p", project, "-f", composePath, action)
	cmd := exec.Command(parts[0], args...)
	cmd.Dir = filepath.Dir(composePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, output)
	}
	return nil
}

// Stop every retained service set, including the last applied configuration.
// A failed deploy can have overwritten a compose file without replacing its
// running services. Never let one invalid stale file prevent other stop attempts.
func composeStopProject(binary, project, composePath string) error {
	dir := filepath.Dir(composePath)
	paths := []string{filepath.Join(dir, activeComposeFile), filepath.Join(dir, stoppedComposeFile), composePath}
	_, activeErr := os.Stat(filepath.Join(dir, activeComposeFile))
	_, canonicalErr := os.Stat(filepath.Join(dir, managedComposeFile))
	if os.IsNotExist(activeErr) && os.IsNotExist(canonicalErr) {
		// Pre-upgrade projects have no authoritative applied snapshot. Consider
		// all possible old service sets rather than silently stopping the wrong one.
		for _, name := range []string{"compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"} {
			paths = append(paths, filepath.Join(dir, name))
		}
	}
	seen := map[string]bool{}
	var failures []error
	for _, path := range paths {
		if seen[path] {
			continue
		}
		seen[path] = true
		if _, err := os.Stat(path); err != nil {
			if !os.IsNotExist(err) {
				failures = append(failures, err)
			}
			continue
		}
		if err := composeAction(binary, project, path, "stop"); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func copyComposeFile(from, to string) error {
	data, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return writeProjectFile(to, data, composeFileMode)
}

func isManagedProjectFile(name string) bool {
	return name == sourceComposeFile || name == stoppedComposeFile || name == managedComposeFile || name == activeComposeFile
}

package compose

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

type Handler struct {
	cfg         *config.AgentConfig
	clientStore *config.ClientStore
	tracker     *ResourceTracker
	logger      *slog.Logger
}

func NewHandler(cfg *config.AgentConfig, clientStore *config.ClientStore, logger *slog.Logger) *Handler {
	trackerPath := filepath.Join(cfg.Roles.Compose.DeploymentsDir, "resource-state.json")
	tracker, err := LoadResourceTracker(trackerPath, logger)
	if err != nil {
		logger.Warn("failed to load resource tracker, starting fresh", "error", err)
		tracker = &ResourceTracker{path: trackerPath, Clients: make(map[string]*ClientResources), logger: logger}
	}
	return &Handler{cfg: cfg, clientStore: clientStore, tracker: tracker, logger: logger}
}

// DeployRequest represents a file-based project deployment.
// Files is a map of relative path -> content.
// The project name comes from the URL path, not the request body.
type DeployRequest struct {
	Files map[string]string `json:"files"`
}

type DeployResponse struct {
	Status   string   `json:"status"`
	Project  string   `json:"project"`
	Services []string `json:"services,omitempty"`
	Modified []string `json:"policy_modifications,omitempty"`
}

func (h *Handler) Deploy(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	if client.Compose == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "compose role not allowed for this client"})
		return
	}

	projectSlug := r.PathValue("project")
	if projectSlug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project name is required"})
		return
	}

	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Find compose file in the files map
	composeContent := findComposeFile(req.Files)
	if composeContent == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no compose.yml, compose.yaml, or docker-compose.yml found in files"})
		return
	}

	// Parse compose YAML
	composeFile, err := parseCompose([]byte(composeContent))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid compose file: %v", err)})
		return
	}

	// Validate against deny-list and policies
	violations := validateCompose(composeFile, h.cfg, client.Compose)
	if len(violations) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":      "policy violations",
			"violations": violations,
		})
		return
	}

	// Check resource budget across ALL projects for this client
	requestedResources := calculateResources(composeFile, client.Compose)
	if err := h.tracker.CheckBudget(client.Client, projectSlug, client.Compose, requestedResources); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("resource budget exceeded: %v", err),
		})
		return
	}

	// Apply hardening and namespacing
	modifications := hardenCompose(composeFile, h.cfg, client)

	// Write all project files
	projectName := fmt.Sprintf("opsen-%s-%s", client.Client, projectSlug)
	projectDir := filepath.Join(h.cfg.Roles.Compose.DeploymentsDir, client.Client, projectSlug)
	if err := os.MkdirAll(projectDir, 0750); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create project directory"})
		return
	}

	// Write each file from the request
	var composeFilePath string
	for relPath, content := range req.Files {
		cleanPath := filepath.Clean(relPath)
		if strings.HasPrefix(cleanPath, "..") || filepath.IsAbs(cleanPath) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("invalid file path: %s", relPath)})
			return
		}

		fullPath := filepath.Join(projectDir, cleanPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0750); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to create directory for %s", relPath)})
			return
		}

		// For the compose file, write the hardened version
		if isComposeFile(cleanPath) {
			transformed, merr := marshalCompose(composeFile)
			if merr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to serialize compose file"})
				return
			}
			if werr := os.WriteFile(fullPath, transformed, 0640); werr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write compose file"})
				return
			}
			composeFilePath = fullPath
		} else {
			if werr := os.WriteFile(fullPath, []byte(content), 0640); werr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to write file %s", relPath)})
				return
			}
		}
	}

	if composeFilePath == "" {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "compose file path not resolved"})
		return
	}

	// Run docker compose up
	services, err := h.composeUp(projectName, composeFilePath)
	if err != nil {
		h.logger.Error("compose up failed", "client", client.Client, "project", projectSlug, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("deploy failed: %v", err)})
		return
	}

	// Track resources
	h.tracker.Set(client.Client, projectSlug, requestedResources)

	h.logger.Info("deployed", "client", client.Client, "project", projectSlug, "services", services)
	writeJSON(w, http.StatusOK, DeployResponse{
		Status:   "deployed",
		Project:  projectName,
		Services: services,
		Modified: modifications,
	})
}

func (h *Handler) Destroy(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	projectSlug := r.PathValue("project")
	if projectSlug == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project name is required"})
		return
	}

	projectName := fmt.Sprintf("opsen-%s-%s", client.Client, projectSlug)
	projectDir := filepath.Join(h.cfg.Roles.Compose.DeploymentsDir, client.Client, projectSlug)
	composePath := findComposeFileOnDisk(projectDir)

	if composePath == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no deployment found"})
		return
	}

	if err := h.composeDown(projectName, composePath); err != nil {
		h.logger.Error("compose down failed", "client", client.Client, "project", projectSlug, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("destroy failed: %v", err)})
		return
	}

	os.RemoveAll(projectDir)
	h.tracker.Remove(client.Client, projectSlug)

	h.logger.Info("destroyed", "client", client.Client, "project", projectSlug)
	writeJSON(w, http.StatusOK, map[string]string{"status": "destroyed", "project": projectName})
}

func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	projectSlug := r.PathValue("project")

	if projectSlug == "" {
		h.statusAll(w, client)
		return
	}

	projectName := fmt.Sprintf("opsen-%s-%s", client.Client, projectSlug)
	output, err := h.composePsJSON(projectName)

	status := "running"
	if err != nil {
		status = "unknown"
		output = []byte("[]")
	}

	resources := h.tracker.GetProject(client.Client, projectSlug)

	writeJSON(w, http.StatusOK, map[string]any{
		"project":    projectName,
		"status":     status,
		"containers": json.RawMessage(output),
		"resources":  resources,
	})
}

func (h *Handler) statusAll(w http.ResponseWriter, client *config.ClientPolicy) {
	clientResources := h.tracker.GetClient(client.Client)

	type projectInfo struct {
		Project   string            `json:"project"`
		Resources *ProjectResources `json:"resources,omitempty"`
	}

	var projects []projectInfo
	if clientResources != nil {
		for name, res := range clientResources.Projects {
			projects = append(projects, projectInfo{
				Project:   name,
				Resources: res,
			})
		}
	}

	total := TotalResources{}
	if clientResources != nil {
		total = clientResources.Total()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"client":   client.Client,
		"projects": projects,
		"total":    total,
	})
}

func (h *Handler) composeUp(project, composePath string) ([]string, error) {
	composeBin := h.cfg.Roles.Compose.ComposeBinary
	parts := strings.Fields(composeBin)

	args := append(parts[1:], "-p", project, "-f", composePath, "up", "-d", "--remove-orphans")
	cmd := exec.Command(parts[0], args...)
	cmd.Dir = filepath.Dir(composePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s: %s", err, string(output))
	}

	psArgs := append(parts[1:], "-p", project, "-f", composePath, "ps", "--services")
	psCmd := exec.Command(parts[0], psArgs...)
	psCmd.Dir = filepath.Dir(composePath)
	svcOutput, _ := psCmd.CombinedOutput()

	var services []string
	for _, line := range strings.Split(strings.TrimSpace(string(svcOutput)), "\n") {
		if line != "" {
			services = append(services, line)
		}
	}

	return services, nil
}

func (h *Handler) composeDown(project, composePath string) error {
	composeBin := h.cfg.Roles.Compose.ComposeBinary
	parts := strings.Fields(composeBin)

	args := append(parts[1:], "-p", project, "-f", composePath, "down", "--volumes", "--remove-orphans")
	cmd := exec.Command(parts[0], args...)
	cmd.Dir = filepath.Dir(composePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, string(output))
	}
	return nil
}

func (h *Handler) composePsJSON(project string) ([]byte, error) {
	composeBin := h.cfg.Roles.Compose.ComposeBinary
	parts := strings.Fields(composeBin)

	args := append(parts[1:], "-p", project, "ps", "--format", "json")
	cmd := exec.Command(parts[0], args...)
	return cmd.CombinedOutput()
}

func findComposeFile(files map[string]string) string {
	for _, name := range []string{"compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"} {
		if content, ok := files[name]; ok {
			return content
		}
	}
	return ""
}

func isComposeFile(path string) bool {
	base := filepath.Base(path)
	for _, name := range []string{"compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"} {
		if base == name {
			return true
		}
	}
	return false
}

func findComposeFileOnDisk(projectDir string) string {
	for _, name := range []string{"compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"} {
		path := filepath.Join(projectDir, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

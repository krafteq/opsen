package compose

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/opsen/agent/internal/config"
)

// ProjectResources tracks resource usage for a single compose project.
type ProjectResources struct {
	Containers int     `json:"containers"`
	MemoryMb   int     `json:"memory_mb"`
	Cpus       float64 `json:"cpus"`
	PolicyHash string  `json:"policy_hash,omitempty"` // hash of policy fields affecting deployment
	CreatedAt  string  `json:"created_at"`
	ModifiedAt string  `json:"modified_at"`
}

// TotalResources is the aggregated usage across all projects for a client.
type TotalResources struct {
	Containers int     `json:"containers"`
	MemoryMb   int     `json:"memory_mb"`
	Cpus       float64 `json:"cpus"`
	Projects   int     `json:"projects"`
}

// ClientResources tracks all projects for one client.
type ClientResources struct {
	Projects map[string]*ProjectResources `json:"projects"`
}

func (c *ClientResources) Total() TotalResources {
	t := TotalResources{Projects: len(c.Projects)}
	for _, p := range c.Projects {
		t.Containers += p.Containers
		t.MemoryMb += p.MemoryMb
		t.Cpus += p.Cpus
	}
	return t
}

// ResourceTracker persists resource usage across agent restarts.
type ResourceTracker struct {
	mu      sync.RWMutex
	path    string
	Clients map[string]*ClientResources `json:"clients"`
	logger  *slog.Logger
}

func LoadResourceTracker(path string, logger *slog.Logger) (*ResourceTracker, error) {
	tracker := &ResourceTracker{
		path:    path,
		Clients: make(map[string]*ClientResources),
		logger:  logger,
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return tracker, nil
		}
		return nil, fmt.Errorf("reading resource state: %w", err)
	}

	if err := json.Unmarshal(data, tracker); err != nil {
		return nil, fmt.Errorf("parsing resource state: %w", err)
	}

	return tracker, nil
}

func (t *ResourceTracker) save() {
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		t.logger.Error("failed to serialize resource state", "error", err)
		return
	}
	if err := os.WriteFile(t.path, data, 0640); err != nil {
		t.logger.Error("failed to write resource state", "error", err)
	}
}

// CheckBudget verifies that deploying a new project (or updating an existing one)
// won't exceed the client's total resource limits.
func (t *ResourceTracker) CheckBudget(clientName, projectName string, policy *config.ComposePolicy, requested *ProjectResources) error {
	t.mu.RLock()
	defer t.mu.RUnlock()

	client := t.Clients[clientName]

	// Calculate current usage excluding the project being updated
	current := TotalResources{}
	if client != nil {
		for name, p := range client.Projects {
			if name == projectName {
				continue // this project is being replaced
			}
			current.Containers += p.Containers
			current.MemoryMb += p.MemoryMb
			current.Cpus += p.Cpus
		}
	}

	newTotal := TotalResources{
		Containers: current.Containers + requested.Containers,
		MemoryMb:   current.MemoryMb + requested.MemoryMb,
		Cpus:       current.Cpus + requested.Cpus,
	}

	if policy.MaxContainers > 0 && newTotal.Containers > policy.MaxContainers {
		return fmt.Errorf("total containers would be %d (limit: %d, current: %d across other projects, requested: %d)",
			newTotal.Containers, policy.MaxContainers, current.Containers, requested.Containers)
	}
	if policy.MaxMemoryMb > 0 && newTotal.MemoryMb > policy.MaxMemoryMb {
		return fmt.Errorf("total memory would be %dMB (limit: %dMB, current: %dMB across other projects, requested: %dMB)",
			newTotal.MemoryMb, policy.MaxMemoryMb, current.MemoryMb, requested.MemoryMb)
	}
	if policy.MaxCpus > 0 && newTotal.Cpus > policy.MaxCpus {
		return fmt.Errorf("total CPUs would be %.1f (limit: %.1f, current: %.1f across other projects, requested: %.1f)",
			newTotal.Cpus, policy.MaxCpus, current.Cpus, requested.Cpus)
	}

	return nil
}

// Set records resource usage for a project, replacing any previous record.
func (t *ResourceTracker) Set(clientName, projectName string, resources *ProjectResources) {
	t.mu.Lock()
	defer t.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339)
	client := t.Clients[clientName]
	if client == nil {
		client = &ClientResources{Projects: make(map[string]*ProjectResources)}
		t.Clients[clientName] = client
	}
	if existing := client.Projects[projectName]; existing != nil && existing.CreatedAt != "" {
		resources.CreatedAt = existing.CreatedAt
	} else {
		resources.CreatedAt = now
	}
	resources.ModifiedAt = now
	client.Projects[projectName] = resources
	t.save()
}

// Remove deletes the resource record for a project.
func (t *ResourceTracker) Remove(clientName, projectName string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	client := t.Clients[clientName]
	if client == nil {
		return
	}
	delete(client.Projects, projectName)
	if len(client.Projects) == 0 {
		delete(t.Clients, clientName)
	}
	t.save()
}

// GetProject returns the resource usage for a specific project.
func (t *ResourceTracker) GetProject(clientName, projectName string) *ProjectResources {
	t.mu.RLock()
	defer t.mu.RUnlock()

	client := t.Clients[clientName]
	if client == nil {
		return nil
	}
	return client.Projects[projectName]
}

// GetClient returns all resource info for a client.
func (t *ResourceTracker) GetClient(clientName string) *ClientResources {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.Clients[clientName]
}

// calculateResources computes the resources a compose file will consume.
func calculateResources(compose *ComposeFile, policy *config.ComposePolicy) *ProjectResources {
	res := &ProjectResources{
		Containers: len(compose.Services),
	}

	for _, svc := range compose.Services {
		mem := parseMemoryMb(svc.MemLimit)
		if mem == 0 {
			mem = policy.PerContainer.DefaultMemoryMb
		}
		res.MemoryMb += mem

		cpus := parseCpus(svc.Cpus)
		if cpus == 0 {
			cpus = policy.PerContainer.DefaultCpus
		}
		res.Cpus += cpus
	}

	return res
}

func parseCpus(v any) float64 {
	switch c := v.(type) {
	case float64:
		return c
	case int:
		return float64(c)
	case string:
		var f float64
		fmt.Sscanf(c, "%f", &f)
		return f
	}
	return 0
}

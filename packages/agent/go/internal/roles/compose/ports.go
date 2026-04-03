package compose

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
)

// PortMapping describes a single allocated port binding.
type PortMapping struct {
	HostPort      int    `json:"host_port"`
	ContainerPort string `json:"container_port"`
	Service       string `json:"service"`
}

// ProjectPorts holds all port allocations for a single project.
type ProjectPorts struct {
	Ports []PortMapping `json:"ports"`
}

// PortAllocator manages host port assignments from a configured range.
// Allocations are persisted to survive agent restarts.
type PortAllocator struct {
	mu       sync.Mutex
	path     string
	logger   *slog.Logger
	rangeMin int
	rangeMax int
	// Clients maps client name -> project slug -> allocated ports
	Clients map[string]map[string]*ProjectPorts `json:"clients"`
}

func NewPortAllocator(path string, portRange string, logger *slog.Logger) (*PortAllocator, error) {
	min, max, err := parsePortRange(portRange)
	if err != nil {
		return nil, fmt.Errorf("invalid port range: %w", err)
	}

	pa := &PortAllocator{
		path:     path,
		logger:   logger,
		rangeMin: min,
		rangeMax: max,
		Clients:  make(map[string]map[string]*ProjectPorts),
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("reading port state: %w", err)
		}
	} else {
		if err := json.Unmarshal(data, pa); err != nil {
			return nil, fmt.Errorf("parsing port state: %w", err)
		}
	}

	return pa, nil
}

// Allocate assigns host ports for exposed container ports in a project.
// If the project already has allocations and the exposed ports haven't changed,
// existing allocations are reused. Otherwise, old ports are released and new ones allocated.
func (pa *PortAllocator) Allocate(clientName, projectSlug string, requests []ServicePort) ([]PortMapping, error) {
	pa.mu.Lock()
	defer pa.mu.Unlock()

	used := pa.usedPorts(clientName, projectSlug)

	// Check if existing allocations can be reused
	existing := pa.getProject(clientName, projectSlug)
	if existing != nil && portsMatch(existing.Ports, requests) {
		return existing.Ports, nil
	}

	var mappings []PortMapping
	for _, req := range requests {
		port, err := pa.findFreePort(used)
		if err != nil {
			return nil, fmt.Errorf("service %s port %s: %w", req.Service, req.ContainerPort, err)
		}
		used[port] = true
		mappings = append(mappings, PortMapping{
			HostPort:      port,
			ContainerPort: req.ContainerPort,
			Service:       req.Service,
		})
	}

	if pa.Clients[clientName] == nil {
		pa.Clients[clientName] = make(map[string]*ProjectPorts)
	}
	pa.Clients[clientName][projectSlug] = &ProjectPorts{Ports: mappings}
	pa.save()

	return mappings, nil
}

// Release frees all port allocations for a project.
func (pa *PortAllocator) Release(clientName, projectSlug string) {
	pa.mu.Lock()
	defer pa.mu.Unlock()

	client := pa.Clients[clientName]
	if client == nil {
		return
	}
	delete(client, projectSlug)
	if len(client) == 0 {
		delete(pa.Clients, clientName)
	}
	pa.save()
}

// GetProject returns the port allocations for a project.
func (pa *PortAllocator) GetProject(clientName, projectSlug string) *ProjectPorts {
	pa.mu.Lock()
	defer pa.mu.Unlock()
	return pa.getProject(clientName, projectSlug)
}

func (pa *PortAllocator) getProject(clientName, projectSlug string) *ProjectPorts {
	client := pa.Clients[clientName]
	if client == nil {
		return nil
	}
	return client[projectSlug]
}

// ServicePort is a request to allocate a host port for a service's container port.
type ServicePort struct {
	Service       string
	ContainerPort string
}

// usedPorts returns all host ports currently allocated, excluding the given project
// (since it's being replaced).
func (pa *PortAllocator) usedPorts(excludeClient, excludeProject string) map[int]bool {
	used := make(map[int]bool)
	for client, projects := range pa.Clients {
		for project, pp := range projects {
			if client == excludeClient && project == excludeProject {
				continue
			}
			for _, m := range pp.Ports {
				used[m.HostPort] = true
			}
		}
	}
	return used
}

func (pa *PortAllocator) findFreePort(used map[int]bool) (int, error) {
	for port := pa.rangeMin; port <= pa.rangeMax; port++ {
		if !used[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no free ports in range %d-%d", pa.rangeMin, pa.rangeMax)
}

func (pa *PortAllocator) save() {
	data, err := json.MarshalIndent(pa, "", "  ")
	if err != nil {
		pa.logger.Error("failed to serialize port state", "error", err)
		return
	}
	if err := os.WriteFile(pa.path, data, 0640); err != nil {
		pa.logger.Error("failed to write port state", "error", err)
	}
}

// portsMatch checks if existing allocations cover exactly the requested ports.
func portsMatch(existing []PortMapping, requests []ServicePort) bool {
	if len(existing) != len(requests) {
		return false
	}
	type key struct{ svc, port string }
	have := make(map[key]bool, len(existing))
	for _, m := range existing {
		have[key{m.Service, m.ContainerPort}] = true
	}
	for _, r := range requests {
		if !have[key{r.Service, r.ContainerPort}] {
			return false
		}
	}
	return true
}

func parsePortRange(s string) (int, int, error) {
	if s == "" {
		return 0, 0, fmt.Errorf("empty port range")
	}
	parts := strings.SplitN(s, "-", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("expected format: min-max (e.g. 8000-8999)")
	}
	min, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid min port: %w", err)
	}
	max, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid max port: %w", err)
	}
	if min > max {
		return 0, 0, fmt.Errorf("min port %d > max port %d", min, max)
	}
	if min < 1 || max > 65535 {
		return 0, 0, fmt.Errorf("ports must be in range 1-65535")
	}
	return min, max, nil
}

// extractExposeEntries collects all exposed ports from a compose file.
// Returns a list of ServicePort requests for port allocation.
func extractExposeEntries(compose *ComposeFile) []ServicePort {
	var requests []ServicePort
	for name, svc := range compose.Services {
		for _, entry := range svc.Expose {
			// expose entries can be "80", "80/tcp", "8080-8090" etc.
			// We only handle simple port numbers.
			port := strings.SplitN(entry, "/", 2)[0]
			requests = append(requests, ServicePort{
				Service:       name,
				ContainerPort: port,
			})
		}
	}
	return requests
}

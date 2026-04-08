package db

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

// DatabaseRecord tracks a single provisioned database.
type DatabaseRecord struct {
	DatabaseName    string   `json:"database_name"`
	OwnerRole       string   `json:"owner_role"`
	AdditionalRoles []string `json:"additional_roles"`
	ConnectionLimit int      `json:"connection_limit"`
	MaxSizeMb       int      `json:"max_size_mb"`
	Extensions      []string `json:"extensions"`
	QuotaExceeded   bool     `json:"quota_exceeded"`
	CreatedAt       string   `json:"created_at"`
	ModifiedAt      string   `json:"modified_at"`
}

// ClientDatabases tracks all databases for one client.
type ClientDatabases struct {
	Databases map[string]*DatabaseRecord `json:"databases"`
}

// ResourceTracker persists database state across agent restarts.
type ResourceTracker struct {
	mu      sync.RWMutex
	path    string
	Clients map[string]*ClientDatabases `json:"clients"`
	logger  *slog.Logger
}

func NewResourceTracker(path string, logger *slog.Logger) *ResourceTracker {
	return &ResourceTracker{
		path:    path,
		Clients: make(map[string]*ClientDatabases),
		logger:  logger,
	}
}

func LoadResourceTracker(path string, logger *slog.Logger) (*ResourceTracker, error) {
	tracker := &ResourceTracker{
		path:    path,
		Clients: make(map[string]*ClientDatabases),
		logger:  logger,
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return tracker, nil
		}
		return nil, fmt.Errorf("reading db state: %w", err)
	}

	if err := json.Unmarshal(data, tracker); err != nil {
		return nil, fmt.Errorf("parsing db state: %w", err)
	}

	return tracker, nil
}

func (t *ResourceTracker) save() {
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		t.logger.Error("failed to serialize db state", "error", err)
		return
	}
	if err := os.WriteFile(t.path, data, 0640); err != nil {
		t.logger.Error("failed to write db state", "error", err)
	}
}

// Set records or updates a database record.
func (t *ResourceTracker) Set(clientName, dbName string, record *DatabaseRecord) {
	t.mu.Lock()
	defer t.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339)
	client := t.Clients[clientName]
	if client == nil {
		client = &ClientDatabases{Databases: make(map[string]*DatabaseRecord)}
		t.Clients[clientName] = client
	}
	if existing := client.Databases[dbName]; existing != nil && existing.CreatedAt != "" {
		record.CreatedAt = existing.CreatedAt
	} else {
		record.CreatedAt = now
	}
	record.ModifiedAt = now
	client.Databases[dbName] = record
	t.save()
}

// Remove deletes a database record.
func (t *ResourceTracker) Remove(clientName, dbName string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	client := t.Clients[clientName]
	if client == nil {
		return
	}
	delete(client.Databases, dbName)
	if len(client.Databases) == 0 {
		delete(t.Clients, clientName)
	}
	t.save()
}

// GetDatabase returns the record for a specific database.
func (t *ResourceTracker) GetDatabase(clientName, dbName string) *DatabaseRecord {
	t.mu.RLock()
	defer t.mu.RUnlock()

	client := t.Clients[clientName]
	if client == nil {
		return nil
	}
	return client.Databases[dbName]
}

// GetClient returns all database info for a client.
func (t *ResourceTracker) GetClient(clientName string) *ClientDatabases {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.Clients[clientName]
}

// DatabaseCount returns the number of databases for a client.
func (t *ResourceTracker) DatabaseCount(clientName string) int {
	t.mu.RLock()
	defer t.mu.RUnlock()

	client := t.Clients[clientName]
	if client == nil {
		return 0
	}
	return len(client.Databases)
}

// SetQuotaExceeded updates the quota_exceeded flag for a database.
func (t *ResourceTracker) SetQuotaExceeded(clientName, dbName string, exceeded bool) {
	t.mu.Lock()
	defer t.mu.Unlock()

	client := t.Clients[clientName]
	if client == nil {
		return
	}
	record := client.Databases[dbName]
	if record == nil {
		return
	}
	record.QuotaExceeded = exceeded
	t.save()
}

// DatabaseOwner returns the client that owns a database name, or "" if available.
func (t *ResourceTracker) DatabaseOwner(dbName string) string {
	t.mu.RLock()
	defer t.mu.RUnlock()

	for clientName, client := range t.Clients {
		if _, ok := client.Databases[dbName]; ok {
			return clientName
		}
	}
	return ""
}

// RoleInUse checks if a role name is used by any database across all clients.
func (t *ResourceTracker) RoleInUse(roleName string) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()

	for _, client := range t.Clients {
		for _, record := range client.Databases {
			if record.OwnerRole == roleName {
				return true
			}
			for _, r := range record.AdditionalRoles {
				if r == roleName {
					return true
				}
			}
		}
	}
	return false
}

// AllDatabases returns all database records across all clients.
func (t *ResourceTracker) AllDatabases() map[string]map[string]*DatabaseRecord {
	t.mu.RLock()
	defer t.mu.RUnlock()

	result := make(map[string]map[string]*DatabaseRecord)
	for clientName, client := range t.Clients {
		dbs := make(map[string]*DatabaseRecord)
		for dbName, record := range client.Databases {
			dbs[dbName] = record
		}
		result[clientName] = dbs
	}
	return result
}

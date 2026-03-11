package db

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

type Handler struct {
	cfg         *config.AgentConfig
	clientStore *config.ClientStore
	pg          *PgManager
	tracker     *ResourceTracker
	logger      *slog.Logger
}

func NewHandler(cfg *config.AgentConfig, clientStore *config.ClientStore, logger *slog.Logger) (*Handler, error) {
	pg, err := NewPgManager(cfg.Roles.Db, logger)
	if err != nil {
		return nil, fmt.Errorf("connecting to postgres: %w", err)
	}

	trackerPath := cfg.Roles.Db.DataDir + "/db-state.json"
	tracker, err := LoadResourceTracker(trackerPath, logger)
	if err != nil {
		logger.Warn("failed to load db resource tracker, starting fresh", "error", err)
		tracker = NewResourceTracker(trackerPath, logger)
	}

	return &Handler{cfg: cfg, clientStore: clientStore, pg: pg, tracker: tracker, logger: logger}, nil
}

// Monitor returns the background size monitor. Caller should run it in a goroutine.
func (h *Handler) Monitor() *SizeMonitor {
	return NewSizeMonitor(h.pg, h.tracker, h.clientStore, h.cfg.Roles.Db, h.logger)
}

// Close cleans up the postgres connection.
func (h *Handler) Close() {
	h.pg.Close()
}

// ── Create Database ─────────────────────────────────────

// CreateDatabaseRequest is the body for PUT /v1/db/databases/{name}.
// The database name comes from the URL path.
type CreateDatabaseRequest struct {
	Owner      OwnerSpec           `json:"owner"`
	Limits     *DatabaseLimitsSpec `json:"limits,omitempty"`
	Extensions []string            `json:"extensions,omitempty"`
}

type OwnerSpec struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type DatabaseLimitsSpec struct {
	MaxSizeMb                  int    `json:"max_size_mb,omitempty"`
	ConnectionLimit            int    `json:"connection_limit,omitempty"`
	StatementTimeout           string `json:"statement_timeout,omitempty"`
	WorkMem                    string `json:"work_mem,omitempty"`
	TempFileLimit              string `json:"temp_file_limit,omitempty"`
	IdleInTransactionTimeout   string `json:"idle_in_transaction_timeout,omitempty"`
	MaintenanceWorkMem         string `json:"maintenance_work_mem,omitempty"`
}

type CreateDatabaseResponse struct {
	Status   string `json:"status"`
	Database string `json:"database"`
	Owner    string `json:"owner"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

func (h *Handler) CreateDatabase(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	if client.Db == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "db role not allowed for this client"})
		return
	}

	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "database name is required"})
		return
	}

	var req CreateDatabaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Owner.Username == "" || req.Owner.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "owner username and password are required"})
		return
	}

	// Validate against policy
	violations := validateCreateRequest(name, &req, client.Db, h.tracker, client.Client)
	if len(violations) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":      "policy violations",
			"violations": violations,
		})
		return
	}

	dbName := fmt.Sprintf("opsen_%s_%s", client.Client, name)
	roleName := fmt.Sprintf("opsen_%s_%s_%s", client.Client, name, req.Owner.Username)

	// Create role
	roleOpts := RoleOptions{
		Password:        req.Owner.Password,
		ConnectionLimit: -1,
	}
	if req.Limits != nil && req.Limits.ConnectionLimit > 0 {
		roleOpts.ConnectionLimit = req.Limits.ConnectionLimit
	}
	if err := h.pg.CreateRole(roleName, roleOpts); err != nil {
		h.logger.Error("failed to create role", "role", roleName, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to create role: %v", err)})
		return
	}

	// Set role GUCs
	gucs := buildRoleGUCs(req.Limits, client.Db)
	for param, value := range gucs {
		if err := h.pg.SetRoleParam(roleName, param, value); err != nil {
			h.logger.Error("failed to set role param", "role", roleName, "param", param, "error", err)
			// Clean up the role
			h.pg.DropRole(roleName)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to set role parameter %s: %v", param, err)})
			return
		}
	}

	// Create database
	connLimit := -1
	if req.Limits != nil && req.Limits.ConnectionLimit > 0 {
		connLimit = req.Limits.ConnectionLimit
	}
	if err := h.pg.CreateDatabase(dbName, roleName, connLimit); err != nil {
		h.logger.Error("failed to create database", "database", dbName, "error", err)
		h.pg.DropRole(roleName)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to create database: %v", err)})
		return
	}

	// Create extensions
	for _, ext := range req.Extensions {
		if err := h.pg.CreateExtension(dbName, ext); err != nil {
			h.logger.Warn("failed to create extension", "database", dbName, "extension", ext, "error", err)
		}
	}

	// Track resources
	maxSizeMb := 0
	if req.Limits != nil {
		maxSizeMb = req.Limits.MaxSizeMb
	}
	h.tracker.Set(client.Client, name, &DatabaseRecord{
		DatabaseName:    dbName,
		OwnerRole:       roleName,
		AdditionalRoles: []string{},
		ConnectionLimit: connLimit,
		MaxSizeMb:       maxSizeMb,
		Extensions:      req.Extensions,
	})

	h.logger.Info("database created", "client", client.Client, "database", dbName, "owner", roleName)
	writeJSON(w, http.StatusOK, CreateDatabaseResponse{
		Status:   "created",
		Database: dbName,
		Owner:    roleName,
		Host:     h.cfg.Roles.Db.Host,
		Port:     h.cfg.Roles.Db.Port,
	})
}

// ── Drop Database ───────────────────────────────────────

func (h *Handler) DropDatabase(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "database name is required"})
		return
	}

	record := h.tracker.GetDatabase(client.Client, name)
	if record == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "database not found"})
		return
	}

	// Drop database first (terminates connections)
	if err := h.pg.DropDatabase(record.DatabaseName); err != nil {
		h.logger.Error("failed to drop database", "database", record.DatabaseName, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to drop database: %v", err)})
		return
	}

	// Drop additional roles first, then owner
	for _, role := range record.AdditionalRoles {
		if err := h.pg.DropRole(role); err != nil {
			h.logger.Warn("failed to drop additional role", "role", role, "error", err)
		}
	}
	if err := h.pg.DropRole(record.OwnerRole); err != nil {
		h.logger.Warn("failed to drop owner role", "role", record.OwnerRole, "error", err)
	}

	h.tracker.Remove(client.Client, name)

	h.logger.Info("database dropped", "client", client.Client, "database", record.DatabaseName)
	writeJSON(w, http.StatusOK, map[string]string{"status": "dropped", "database": record.DatabaseName})
}

// ── Database Status ─────────────────────────────────────

func (h *Handler) DatabaseStatus(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	name := r.PathValue("name")

	if name == "" {
		h.listDatabases(w, client)
		return
	}

	record := h.tracker.GetDatabase(client.Client, name)
	if record == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "database not found"})
		return
	}

	sizeMb, err := h.pg.DatabaseSizeMb(record.DatabaseName)
	if err != nil {
		h.logger.Warn("failed to get database size", "database", record.DatabaseName, "error", err)
	}

	connCount, err := h.pg.ActiveConnections(record.DatabaseName)
	if err != nil {
		h.logger.Warn("failed to get connection count", "database", record.DatabaseName, "error", err)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"database":          record.DatabaseName,
		"owner":             record.OwnerRole,
		"additional_roles":  record.AdditionalRoles,
		"size_mb":           sizeMb,
		"max_size_mb":       record.MaxSizeMb,
		"connection_limit":  record.ConnectionLimit,
		"active_connections": connCount,
		"extensions":        record.Extensions,
		"quota_exceeded":    record.QuotaExceeded,
	})
}

func (h *Handler) listDatabases(w http.ResponseWriter, client *config.ClientPolicy) {
	clientRecord := h.tracker.GetClient(client.Client)

	type dbInfo struct {
		Name          string `json:"name"`
		Database      string `json:"database"`
		SizeMb        int    `json:"size_mb"`
		MaxSizeMb     int    `json:"max_size_mb"`
		QuotaExceeded bool   `json:"quota_exceeded"`
	}

	var databases []dbInfo
	totalSizeMb := 0

	if clientRecord != nil {
		for name, record := range clientRecord.Databases {
			sizeMb, _ := h.pg.DatabaseSizeMb(record.DatabaseName)
			totalSizeMb += sizeMb
			databases = append(databases, dbInfo{
				Name:          name,
				Database:      record.DatabaseName,
				SizeMb:        sizeMb,
				MaxSizeMb:     record.MaxSizeMb,
				QuotaExceeded: record.QuotaExceeded,
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"client":       client.Client,
		"databases":    databases,
		"total_size_mb": totalSizeMb,
		"count":        len(databases),
	})
}

// ── Update Database ─────────────────────────────────────

type UpdateDatabaseRequest struct {
	Limits *DatabaseLimitsSpec `json:"limits,omitempty"`
}

func (h *Handler) UpdateDatabase(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "database name is required"})
		return
	}

	record := h.tracker.GetDatabase(client.Client, name)
	if record == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "database not found"})
		return
	}

	var req UpdateDatabaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Limits == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limits are required"})
		return
	}

	// Validate limits against policy
	violations := validateLimits(req.Limits, client.Db)
	if len(violations) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":      "policy violations",
			"violations": violations,
		})
		return
	}

	// Update connection limit on database
	if req.Limits.ConnectionLimit > 0 {
		if err := h.pg.AlterDatabaseConnectionLimit(record.DatabaseName, req.Limits.ConnectionLimit); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to update connection limit: %v", err)})
			return
		}
		record.ConnectionLimit = req.Limits.ConnectionLimit
	}

	// Update role GUCs
	gucs := buildRoleGUCs(req.Limits, client.Db)
	for param, value := range gucs {
		if err := h.pg.SetRoleParam(record.OwnerRole, param, value); err != nil {
			h.logger.Error("failed to set role param", "role", record.OwnerRole, "param", param, "error", err)
		}
	}

	// Update tracked size limit
	if req.Limits.MaxSizeMb > 0 {
		record.MaxSizeMb = req.Limits.MaxSizeMb
	}

	h.tracker.Set(client.Client, name, record)

	h.logger.Info("database updated", "client", client.Client, "database", record.DatabaseName)
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "database": record.DatabaseName})
}

// ── Create Additional Role ──────────────────────────────

// CreateRoleRequest is the body for PUT /v1/db/databases/{name}/roles/{role}.
// The username comes from the URL path {role} parameter.
type CreateRoleRequest struct {
	Password string `json:"password"`
	ReadOnly bool   `json:"read_only"`
}

func (h *Handler) CreateRole(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	dbName := r.PathValue("name")
	username := r.PathValue("role")
	if dbName == "" || username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "database name and role name are required"})
		return
	}

	record := h.tracker.GetDatabase(client.Client, dbName)
	if record == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "database not found"})
		return
	}

	var req CreateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password is required"})
		return
	}

	// Validate username and password
	violations := validateUsername(username, client.Db)
	violations = append(violations, validatePassword(req.Password, username, client.Db)...)

	// Check max roles per database
	if client.Db.PerDatabase.MaxRoles > 0 && len(record.AdditionalRoles)+1 >= client.Db.PerDatabase.MaxRoles {
		violations = append(violations, fmt.Sprintf("max roles per database reached: %d", client.Db.PerDatabase.MaxRoles))
	}

	if len(violations) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":      "policy violations",
			"violations": violations,
		})
		return
	}

	roleName := fmt.Sprintf("opsen_%s_%s_%s", client.Client, dbName, username)

	roleOpts := RoleOptions{
		Password:        req.Password,
		ConnectionLimit: -1,
	}
	if err := h.pg.CreateRole(roleName, roleOpts); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to create role: %v", err)})
		return
	}

	// Grant connect on the database
	if err := h.pg.GrantConnect(record.DatabaseName, roleName); err != nil {
		h.pg.DropRole(roleName)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to grant connect: %v", err)})
		return
	}

	// If read-only, grant usage on schemas owned by the owner role
	if req.ReadOnly {
		if err := h.pg.GrantReadOnly(record.DatabaseName, roleName, record.OwnerRole); err != nil {
			h.logger.Warn("failed to set read-only grants", "role", roleName, "error", err)
		}
	}

	record.AdditionalRoles = append(record.AdditionalRoles, roleName)
	h.tracker.Set(client.Client, dbName, record)

	h.logger.Info("role created", "client", client.Client, "database", record.DatabaseName, "role", roleName)
	writeJSON(w, http.StatusOK, map[string]string{"status": "created", "role": roleName})
}

// ── Drop Additional Role ────────────────────────────────

func (h *Handler) DropRole(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	dbName := r.PathValue("name")
	username := r.PathValue("role")

	record := h.tracker.GetDatabase(client.Client, dbName)
	if record == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "database not found"})
		return
	}

	// Apply same prefix as CreateRole
	roleName := fmt.Sprintf("opsen_%s_%s_%s", client.Client, dbName, username)

	// Find and remove role from additional roles
	found := false
	var remaining []string
	for _, r := range record.AdditionalRoles {
		if r == roleName {
			found = true
		} else {
			remaining = append(remaining, r)
		}
	}

	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "role not found"})
		return
	}

	if err := h.pg.RevokeConnect(record.DatabaseName, roleName); err != nil {
		h.logger.Warn("failed to revoke connect", "role", roleName, "error", err)
	}
	if err := h.pg.RevokeAllPrivileges(record.DatabaseName, roleName, record.OwnerRole); err != nil {
		h.logger.Warn("failed to revoke privileges", "role", roleName, "error", err)
	}
	if err := h.pg.DropRole(roleName); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to drop role: %v", err)})
		return
	}

	record.AdditionalRoles = remaining
	h.tracker.Set(client.Client, dbName, record)

	h.logger.Info("role dropped", "client", client.Client, "role", roleName)
	writeJSON(w, http.StatusOK, map[string]string{"status": "dropped", "role": roleName})
}

// ── Helpers ─────────────────────────────────────────────

func buildRoleGUCs(limits *DatabaseLimitsSpec, policy *config.DbPolicy) map[string]string {
	gucs := map[string]string{}
	if limits == nil {
		return gucs
	}

	if limits.StatementTimeout != "" {
		gucs["statement_timeout"] = limits.StatementTimeout
	} else if policy.RoleLimits.MinStatementTimeout != "" {
		gucs["statement_timeout"] = policy.RoleLimits.MinStatementTimeout
	}

	if limits.WorkMem != "" {
		gucs["work_mem"] = limits.WorkMem
	}

	if limits.TempFileLimit != "" {
		gucs["temp_file_limit"] = limits.TempFileLimit
	}

	if limits.IdleInTransactionTimeout != "" {
		gucs["idle_in_transaction_session_timeout"] = limits.IdleInTransactionTimeout
	}

	if limits.MaintenanceWorkMem != "" {
		gucs["maintenance_work_mem"] = limits.MaintenanceWorkMem
	}

	return gucs
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

package db

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/opsen/agent/internal/identity"
)

const TemporaryAccessRolesCapability = "temporary-access-roles-v1"

// AccessRoleRecord stores no plaintext password. The fingerprint binds immutable
// request fields (including the high-entropy password); Marker prevents adopting
// an unrelated cluster role after interrupted provisioning.
type AccessRoleRecord struct {
	Role        string   `json:"role"`
	AccessMode  string   `json:"access_mode"`
	Schemas     []string `json:"schemas"`
	ExpiresAt   string   `json:"expires_at"`
	Status      string   `json:"status"`
	Fingerprint string   `json:"fingerprint"`
	Marker      string   `json:"marker"`
}

type AccessRoleRequest struct {
	Password   string   `json:"password"`
	AccessMode string   `json:"access_mode"`
	Schemas    []string `json:"schemas,omitempty"`
	ExpiresAt  string   `json:"expires_at"`
}

func (r *AccessRoleRequest) normalize() error {
	if r.AccessMode != "read" && r.AccessMode != "readwrite" {
		return fmt.Errorf("access_mode must be read or readwrite")
	}
	if !isValidPlaintextPassword(r.Password) || len(r.Password) < 16 || len(r.Password) > 4096 {
		return fmt.Errorf("password must be 16–4096 valid characters; use a randomly generated password")
	}
	expiry, err := time.Parse(time.RFC3339, r.ExpiresAt)
	if err != nil {
		return fmt.Errorf("expires_at must be an RFC3339 timestamp")
	}
	r.ExpiresAt = expiry.UTC().Format(time.RFC3339Nano)
	if len(r.Schemas) == 0 {
		r.Schemas = []string{"public"}
	}
	if len(r.Schemas) > 32 {
		return fmt.Errorf("at most 32 schemas are allowed")
	}
	for _, schema := range r.Schemas {
		if !isValidIdentifier(schema) || strings.HasPrefix(schema, "pg_") || schema == "information_schema" {
			return fmt.Errorf("invalid application schema")
		}
	}
	slices.Sort(r.Schemas)
	r.Schemas = slices.Compact(r.Schemas)
	return nil
}

func accessRoleView(r *AccessRoleRecord) map[string]any {
	return map[string]any{"role": r.Role, "access_mode": r.AccessMode, "schemas": r.Schemas, "expires_at": r.ExpiresAt, "status": r.Status}
}

// setAccessRole persists before publishing a new record in memory. Its caller
// serializes API operations; the tracker lock also protects concurrent saves.
func (t *ResourceTracker) setAccessRole(client, database, role string, value *AccessRoleRecord) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	c := t.Clients[client]
	if c == nil || c.Databases[database] == nil {
		return fmt.Errorf("database not found")
	}
	record := c.Databases[database]
	if record.AccessRoles == nil {
		record.AccessRoles = make(map[string]*AccessRoleRecord)
	}
	previous := record.AccessRoles[role]
	record.AccessRoles[role] = value
	if err := t.save(); err != nil {
		if previous == nil {
			delete(record.AccessRoles, role)
		} else {
			record.AccessRoles[role] = previous
		}
		return err
	}
	return nil
}

func (h *Handler) AccessCapabilities(w http.ResponseWriter, r *http.Request) {
	client := identity.ClientFromContext(r.Context())
	if client == nil || client.Db == nil {
		writeJSON(w, 403, map[string]string{"error": "db role not allowed"})
		return
	}
	writeJSON(w, 200, map[string]any{"capabilities": []string{TemporaryAccessRolesCapability}})
}

func (h *Handler) PutAccessRole(w http.ResponseWriter, r *http.Request) {
	h.accessMu.Lock()
	defer h.accessMu.Unlock()
	client := identity.ClientFromContext(r.Context())
	if client == nil || client.Db == nil {
		writeJSON(w, 403, map[string]string{"error": "db role not allowed"})
		return
	}
	name, role := r.PathValue("name"), r.PathValue("role")
	record := h.tracker.GetDatabase(client.Client, name)
	if record == nil {
		writeJSON(w, 404, map[string]string{"error": "database not found"})
		return
	}
	var req AccessRoleRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid access role request"})
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeJSON(w, 400, map[string]string{"error": "request must contain one JSON object"})
		return
	}
	if err := req.normalize(); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	violations := validateUsername(role, client.Db)
	violations = append(violations, validatePassword(req.Password, role, client.Db)...)
	if !isValidIdentifier(role) || strings.HasPrefix(role, "pg_") || len(violations) > 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid role name or password policy violation"})
		return
	}
	body, _ := json.Marshal(req)
	digest := sha256.Sum256(body)
	fingerprint := hex.EncodeToString(digest[:])
	lease := record.AccessRoles[role]
	if lease != nil {
		if lease.Fingerprint != fingerprint || lease.Status == "revoking" || lease.Status == "revoked" {
			writeJSON(w, 409, map[string]string{"error": "access role request is immutable or revoked"})
			return
		}
		if lease.Status == "active" {
			writeJSON(w, 200, accessRoleView(lease))
			return
		}
	} else {
		expiry, _ := time.Parse(time.RFC3339, req.ExpiresAt)
		if !expiry.After(time.Now()) {
			writeJSON(w, 400, map[string]string{"error": "expires_at must be in the future"})
			return
		}
		if h.tracker.RoleInUse(role) {
			writeJSON(w, 409, map[string]string{"error": "role name already in use"})
			return
		}
		count := len(record.AdditionalRoles) + 1
		for _, entry := range record.AccessRoles {
			if entry.Status != "revoked" {
				count++
			}
		}
		if client.Db.PerDatabase.MaxRoles > 0 && count >= client.Db.PerDatabase.MaxRoles {
			writeJSON(w, 400, map[string]string{"error": "max roles per database reached"})
			return
		}
		marker := make([]byte, 32)
		if _, err := rand.Read(marker); err != nil {
			writeJSON(w, 500, map[string]string{"error": "could not reserve access role"})
			return
		}
		lease = &AccessRoleRecord{Role: role, AccessMode: req.AccessMode, Schemas: req.Schemas, ExpiresAt: req.ExpiresAt, Status: "provisioning", Fingerprint: fingerprint, Marker: "opsen-access-role:" + hex.EncodeToString(marker)}
		if err := h.tracker.setAccessRole(client.Client, name, role, lease); err != nil {
			writeJSON(w, 500, map[string]string{"error": "could not persist access role"})
			return
		}
	}
	if err := h.pg.ProvisionAccessRole(record.DatabaseName, record.OwnerRole, lease, req.Password); err != nil {
		// Never include SQL/provider errors: they can contain a supplied password.
		h.logger.Warn("access role provisioning failed", "role", role)
		writeJSON(w, 500, map[string]string{"error": "access role provisioning failed; retry the identical request or revoke"})
		return
	}
	active := *lease
	active.Status = "active"
	if err := h.tracker.setAccessRole(client.Client, name, role, &active); err != nil {
		writeJSON(w, 500, map[string]string{"error": "could not persist access role; retry the identical request"})
		return
	}
	writeJSON(w, 200, accessRoleView(&active))
}

func (h *Handler) GetAccessRole(w http.ResponseWriter, r *http.Request) {
	h.accessMu.Lock()
	defer h.accessMu.Unlock()
	client := identity.ClientFromContext(r.Context())
	if client == nil || client.Db == nil {
		writeJSON(w, 403, map[string]string{"error": "db role not allowed"})
		return
	}
	record := h.tracker.GetDatabase(client.Client, r.PathValue("name"))
	if record == nil || record.AccessRoles[r.PathValue("role")] == nil {
		writeJSON(w, 404, map[string]string{"error": "access role not found"})
		return
	}
	writeJSON(w, 200, accessRoleView(record.AccessRoles[r.PathValue("role")]))
}

func (h *Handler) DeleteAccessRole(w http.ResponseWriter, r *http.Request) {
	h.accessMu.Lock()
	defer h.accessMu.Unlock()
	client := identity.ClientFromContext(r.Context())
	if client == nil || client.Db == nil {
		writeJSON(w, 403, map[string]string{"error": "db role not allowed"})
		return
	}
	name, role := r.PathValue("name"), r.PathValue("role")
	record := h.tracker.GetDatabase(client.Client, name)
	if record == nil || record.AccessRoles[role] == nil {
		writeJSON(w, 404, map[string]string{"error": "access role not found"})
		return
	}
	lease := *record.AccessRoles[role]
	if lease.Status == "revoked" {
		writeJSON(w, 200, accessRoleView(&lease))
		return
	}
	lease.Status = "revoking"
	if err := h.tracker.setAccessRole(client.Client, name, role, &lease); err != nil {
		writeJSON(w, 500, map[string]string{"error": "could not persist revocation"})
		return
	}
	if err := h.pg.RevokeAccessRole(record.DatabaseName, record.OwnerRole, &lease); err != nil {
		h.logger.Warn("access role revocation failed", "role", role)
		writeJSON(w, 500, map[string]string{"error": "access role revocation incomplete; retry"})
		return
	}
	revoked := lease
	revoked.Status = "revoked"
	if err := h.tracker.setAccessRole(client.Client, name, role, &revoked); err != nil {
		writeJSON(w, 500, map[string]string{"error": "could not persist revocation; retry"})
		return
	}
	writeJSON(w, 200, accessRoleView(&revoked))
}

package db

import (
	"encoding/json"
	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func accessRequest(h *Handler, client *config.ClientPolicy, method, role, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/v1/db/databases/app/access-roles/"+role, strings.NewReader(body))
	r.SetPathValue("name", "app")
	r.SetPathValue("role", role)
	if client != nil {
		r = r.WithContext(identity.WithClient(r.Context(), client))
	}
	w := httptest.NewRecorder()
	switch method {
	case "PUT":
		h.PutAccessRole(w, r)
	case "GET":
		h.GetAccessRole(w, r)
	case "DELETE":
		h.DeleteAccessRole(w, r)
	}
	return w
}

func accessBody(mode, expiry string, schemas ...string) string {
	body, _ := json.Marshal(AccessRoleRequest{Password: "RandomLeasePassword-0123456789", AccessMode: mode, ExpiresAt: expiry, Schemas: schemas})
	return string(body)
}

func TestAccessRoleValidationAndAuthorization(t *testing.T) {
	h, _, client, _ := patchFixture(t)
	expiry := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	for _, body := range []string{
		accessBody("owner", expiry), accessBody("read", "forever"), accessBody("read", expiry, "pg_catalog"), accessBody("read", expiry, "public;DROP ROLE postgres"),
		accessBody("read", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)),
		`{"password":"RandomLeasePassword-0123456789","access_mode":"read","expires_at":"2099-01-01T00:00:00Z","unexpected":true}`,
		accessBody("read", expiry) + ` {}`,
	} {
		if w := accessRequest(h, client, "PUT", "lease_role", body); w.Code != 400 {
			t.Fatalf("expected400 got%d: %s", w.Code, w.Body.String())
		}
	}
	for _, method := range []string{"PUT", "GET", "DELETE"} {
		if w := accessRequest(h, nil, method, "lease_role", accessBody("read", expiry)); w.Code != 403 {
			t.Fatalf("unauthenticated %s: %d", method, w.Code)
		}
		other := &config.ClientPolicy{Client: "another", Db: client.Db}
		if w := accessRequest(h, other, method, "lease_role", accessBody("read", expiry)); w.Code != 404 {
			t.Fatalf("cross-client %s: %d", method, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/v1/db/capabilities", nil)
	w := httptest.NewRecorder()
	h.AccessCapabilities(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	r = r.WithContext(identity.WithClient(r.Context(), client))
	w = httptest.NewRecorder()
	h.AccessCapabilities(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), TemporaryAccessRolesCapability) {
		t.Fatal(w.Body.String())
	}
}

func TestAccessRolePersistenceFailureDoesNotCreateRole(t *testing.T) {
	h, _, client, _ := patchFixture(t)
	h.tracker.path = "/does-not-exist/state.json"
	w := accessRequest(h, client, "PUT", "lease_role", accessBody("read", time.Now().Add(time.Hour).UTC().Format(time.RFC3339)))
	if w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	if h.tracker.RoleInUse("lease_role") {
		t.Fatal("failed reservation remained in memory")
	}
}

func TestAccessRolePreservesExpiryPrecision(t *testing.T) {
	req := AccessRoleRequest{Password: "RandomLeasePassword-0123456789", AccessMode: "read", ExpiresAt: "2099-01-01T01:00:00.123+01:00"}
	if err := req.normalize(); err != nil {
		t.Fatal(err)
	}
	if req.ExpiresAt != "2099-01-01T00:00:00.123Z" {
		t.Fatal(req.ExpiresAt)
	}
}

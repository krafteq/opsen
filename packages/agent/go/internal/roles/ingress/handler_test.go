package ingress

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func testHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	configDir := t.TempDir()
	cfg := &config.AgentConfig{
		Roles: config.RolesConfig{
			Ingress: &config.IngressRoleConfig{
				Driver:    "caddy",
				ConfigDir: configDir,
			},
		},
	}
	clientStore, err := config.NewClientStore(t.TempDir(), testLogger())
	if err != nil {
		t.Fatalf("NewClientStore: %v", err)
	}
	h := NewHandler(cfg, clientStore, testLogger())
	return h, configDir
}

func testClient(name string) *config.ClientPolicy {
	return &config.ClientPolicy{
		Client: name,
		Ingress: &config.IngressPolicy{
			MaxRoutes: 10,
			Domains: config.DomainPolicy{
				Allowed: []string{"*.example.com"},
			},
			Upstreams: config.UpstreamPolicy{},
		},
	}
}

func doRequest(h http.HandlerFunc, method, path string, body any, client *config.ClientPolicy) *httptest.ResponseRecorder {
	var reqBody io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reqBody = bytes.NewReader(data)
	}

	req := httptest.NewRequest(method, path, reqBody)
	req.Header.Set("Content-Type", "application/json")

	// Inject client policy into context (bypasses mTLS middleware)
	ctx := identity.WithClient(req.Context(), client)
	req = req.WithContext(ctx)

	// Set path values via the mux pattern
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// doMuxRequest uses an http.ServeMux so PathValue works for {app}, {name} etc.
func doMuxRequest(mux *http.ServeMux, method, path string, body any, client *config.ClientPolicy) *httptest.ResponseRecorder {
	var reqBody io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reqBody = bytes.NewReader(data)
	}

	req := httptest.NewRequest(method, path, reqBody)
	req.Header.Set("Content-Type", "application/json")
	ctx := identity.WithClient(req.Context(), client)
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func setupMux(h *Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/ingress/apps/{app}/routes", h.UpdateAppRoutes)
	mux.HandleFunc("GET /v1/ingress/apps/{app}/routes", h.ListAppRoutes)
	mux.HandleFunc("DELETE /v1/ingress/apps/{app}", h.DeleteApp)
	mux.HandleFunc("PUT /v1/ingress/routes", h.UpdateRoutes)
	mux.HandleFunc("DELETE /v1/ingress/routes/{name}", h.DeleteRoute)
	mux.HandleFunc("GET /v1/ingress/routes", h.ListRoutes)
	return mux
}

func parseResponse(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v\nbody: %s", err, rr.Body.String())
	}
	return resp
}

// ── Tests ───────────────────────────────────────────────

func TestUpdateAppRoutes_Basic(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{
			{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "localhost:3000"},
		},
	}, client)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	resp := parseResponse(t, rr)
	if resp["app"] != "frontend" {
		t.Errorf("expected app=frontend, got %v", resp["app"])
	}
	if resp["routes"].(float64) != 1 {
		t.Errorf("expected routes=1, got %v", resp["routes"])
	}

	// Verify config file was created with correct name
	configFile := filepath.Join(configDir, "acme--frontend.conf")
	if _, err := os.Stat(configFile); os.IsNotExist(err) {
		t.Errorf("expected config file %s to exist", configFile)
	}
}

func TestAppScoping_Isolation(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	// Deploy routes for app "frontend"
	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{
			{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "localhost:3000"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("frontend PUT: %d %s", rr.Code, rr.Body.String())
	}

	// Deploy routes for app "api"
	rr = doMuxRequest(mux, "PUT", "/v1/ingress/apps/api/routes", RouteRequest{
		Routes: []Route{
			{Name: "api-v1", Hosts: []string{"api.example.com"}, Upstream: "localhost:8000"},
			{Name: "api-v2", Hosts: []string{"api-v2.example.com"}, Upstream: "localhost:8001"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("api PUT: %d %s", rr.Code, rr.Body.String())
	}

	// Verify both config files exist independently
	for _, name := range []string{"acme--frontend.conf", "acme--api.conf"} {
		if _, err := os.Stat(filepath.Join(configDir, name)); os.IsNotExist(err) {
			t.Errorf("expected %s to exist", name)
		}
	}

	// List frontend routes — should only see frontend's routes
	rr = doMuxRequest(mux, "GET", "/v1/ingress/apps/frontend/routes", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("frontend GET: %d", rr.Code)
	}
	resp := parseResponse(t, rr)
	routes := resp["routes"].([]any)
	if len(routes) != 1 {
		t.Errorf("expected 1 frontend route, got %d", len(routes))
	}

	// List api routes — should only see api's routes
	rr = doMuxRequest(mux, "GET", "/v1/ingress/apps/api/routes", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("api GET: %d", rr.Code)
	}
	resp = parseResponse(t, rr)
	routes = resp["routes"].([]any)
	if len(routes) != 2 {
		t.Errorf("expected 2 api routes, got %d", len(routes))
	}

	// Update frontend — should NOT affect api routes
	rr = doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{
			{Name: "web-v2", Hosts: []string{"new.example.com"}, Upstream: "localhost:4000"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("frontend update: %d", rr.Code)
	}

	// Verify api routes are untouched
	rr = doMuxRequest(mux, "GET", "/v1/ingress/apps/api/routes", nil, client)
	resp = parseResponse(t, rr)
	routes = resp["routes"].([]any)
	if len(routes) != 2 {
		t.Errorf("api routes should be untouched after frontend update, got %d", len(routes))
	}
}

func TestDeleteApp(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	// Create two apps
	doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "localhost:3000"}},
	}, client)
	doMuxRequest(mux, "PUT", "/v1/ingress/apps/api/routes", RouteRequest{
		Routes: []Route{{Name: "api", Hosts: []string{"api.example.com"}, Upstream: "localhost:8000"}},
	}, client)

	// Delete frontend app
	rr := doMuxRequest(mux, "DELETE", "/v1/ingress/apps/frontend", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("delete frontend: %d %s", rr.Code, rr.Body.String())
	}

	// Frontend config should be gone
	if _, err := os.Stat(filepath.Join(configDir, "acme--frontend.conf")); !os.IsNotExist(err) {
		t.Error("expected frontend config to be deleted")
	}

	// API config should still exist
	if _, err := os.Stat(filepath.Join(configDir, "acme--api.conf")); os.IsNotExist(err) {
		t.Error("expected api config to still exist")
	}

	// Delete already-deleted app should be idempotent (200)
	rr = doMuxRequest(mux, "DELETE", "/v1/ingress/apps/frontend", nil, client)
	if rr.Code != http.StatusOK {
		t.Errorf("expected idempotent delete to return 200, got %d", rr.Code)
	}
}

func TestCrossAppMaxRoutes(t *testing.T) {
	h, _ := testHandler(t)
	mux := setupMux(h)
	client := &config.ClientPolicy{
		Client: "acme",
		Ingress: &config.IngressPolicy{
			MaxRoutes: 3,
			Domains:   config.DomainPolicy{Allowed: []string{"*.example.com"}},
		},
	}

	// App "frontend" creates 2 routes — should succeed
	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{
			{Name: "web1", Hosts: []string{"a.example.com"}, Upstream: "localhost:3000"},
			{Name: "web2", Hosts: []string{"b.example.com"}, Upstream: "localhost:3001"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("frontend 2 routes: %d %s", rr.Code, rr.Body.String())
	}

	// App "api" creates 2 routes — total would be 4, exceeds max 3
	rr = doMuxRequest(mux, "PUT", "/v1/ingress/apps/api/routes", RouteRequest{
		Routes: []Route{
			{Name: "api1", Hosts: []string{"c.example.com"}, Upstream: "localhost:8000"},
			{Name: "api2", Hosts: []string{"d.example.com"}, Upstream: "localhost:8001"},
		},
	}, client)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for exceeding MaxRoutes, got %d: %s", rr.Code, rr.Body.String())
	}
	resp := parseResponse(t, rr)
	if resp["error"] != "policy violations" {
		t.Errorf("expected policy violations error, got %v", resp["error"])
	}

	// App "api" creates 1 route — total would be 3, exactly at limit
	rr = doMuxRequest(mux, "PUT", "/v1/ingress/apps/api/routes", RouteRequest{
		Routes: []Route{
			{Name: "api1", Hosts: []string{"c.example.com"}, Upstream: "localhost:8000"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("api 1 route (at limit): %d %s", rr.Code, rr.Body.String())
	}
}

func TestCrossAppMaxRoutes_UpdateDoesNotDoubleCount(t *testing.T) {
	h, _ := testHandler(t)
	mux := setupMux(h)
	client := &config.ClientPolicy{
		Client: "acme",
		Ingress: &config.IngressPolicy{
			MaxRoutes: 2,
			Domains:   config.DomainPolicy{Allowed: []string{"*.example.com"}},
		},
	}

	// Create 2 routes in "frontend"
	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{
			{Name: "web1", Hosts: []string{"a.example.com"}, Upstream: "localhost:3000"},
			{Name: "web2", Hosts: []string{"b.example.com"}, Upstream: "localhost:3001"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("initial: %d %s", rr.Code, rr.Body.String())
	}

	// Update "frontend" with same 2 routes — should succeed (replacing, not adding)
	rr = doMuxRequest(mux, "PUT", "/v1/ingress/apps/frontend/routes", RouteRequest{
		Routes: []Route{
			{Name: "web3", Hosts: []string{"c.example.com"}, Upstream: "localhost:4000"},
			{Name: "web4", Hosts: []string{"d.example.com"}, Upstream: "localhost:4001"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("update should succeed (replacing same count): %d %s", rr.Code, rr.Body.String())
	}
}

func TestLegacyEndpoints(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	// Legacy PUT
	rr := doMuxRequest(mux, "PUT", "/v1/ingress/routes", RouteRequest{
		Routes: []Route{
			{Name: "legacy", Hosts: []string{"old.example.com"}, Upstream: "localhost:5000"},
		},
	}, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy PUT: %d %s", rr.Code, rr.Body.String())
	}

	// Config file should use _default app
	configFile := filepath.Join(configDir, "acme--_default.conf")
	if _, err := os.Stat(configFile); os.IsNotExist(err) {
		t.Errorf("expected legacy config file %s", configFile)
	}

	// Legacy GET
	rr = doMuxRequest(mux, "GET", "/v1/ingress/routes", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy GET: %d", rr.Code)
	}
	resp := parseResponse(t, rr)
	routes := resp["routes"].([]any)
	if len(routes) != 1 {
		t.Errorf("expected 1 legacy route, got %d", len(routes))
	}

	// Legacy DELETE
	rr = doMuxRequest(mux, "DELETE", "/v1/ingress/routes/legacy", nil, client)
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy DELETE: %d %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(configFile); !os.IsNotExist(err) {
		t.Error("expected legacy config file to be deleted")
	}
}

func TestLegacyAndAppScoped_Coexist(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	// Create routes via legacy endpoint
	doMuxRequest(mux, "PUT", "/v1/ingress/routes", RouteRequest{
		Routes: []Route{{Name: "old", Hosts: []string{"old.example.com"}, Upstream: "localhost:5000"}},
	}, client)

	// Create routes via app-scoped endpoint
	doMuxRequest(mux, "PUT", "/v1/ingress/apps/myapp/routes", RouteRequest{
		Routes: []Route{{Name: "new", Hosts: []string{"new.example.com"}, Upstream: "localhost:6000"}},
	}, client)

	// Both config files should exist
	if _, err := os.Stat(filepath.Join(configDir, "acme--_default.conf")); os.IsNotExist(err) {
		t.Error("expected legacy config to exist")
	}
	if _, err := os.Stat(filepath.Join(configDir, "acme--myapp.conf")); os.IsNotExist(err) {
		t.Error("expected app config to exist")
	}

	// Deleting app should not affect legacy
	doMuxRequest(mux, "DELETE", "/v1/ingress/apps/myapp", nil, client)
	if _, err := os.Stat(filepath.Join(configDir, "acme--_default.conf")); os.IsNotExist(err) {
		t.Error("legacy config should survive app deletion")
	}
}

func TestInvalidAppName(t *testing.T) {
	h, _ := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	// Only test names that produce valid HTTP request paths
	cases := []string{
		"-leading-dash",
		".dot-start",
	}

	for _, name := range cases {
		rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/"+name+"/routes", RouteRequest{
			Routes: []Route{{Name: "x", Hosts: []string{"x.example.com"}, Upstream: "localhost:80"}},
		}, client)
		if rr.Code != http.StatusBadRequest {
			t.Errorf("app name %q: expected 400, got %d", name, rr.Code)
		}
	}
}

func TestValidAppNames(t *testing.T) {
	h, _ := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	cases := []string{
		"frontend",
		"api-v2",
		"my_app",
		"MyApp.v1",
		"_default",
		"a",
		"123",
	}

	for _, name := range cases {
		rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/"+name+"/routes", RouteRequest{
			Routes: []Route{{Name: "r", Hosts: []string{"r.example.com"}, Upstream: "localhost:80"}},
		}, client)
		if rr.Code != http.StatusOK {
			t.Errorf("app name %q: expected 200, got %d: %s", name, rr.Code, rr.Body.String())
		}
	}
}

func TestNoIngressPolicy_Forbidden(t *testing.T) {
	h, _ := testHandler(t)
	mux := setupMux(h)
	client := &config.ClientPolicy{
		Client:  "noaccess",
		Ingress: nil, // no ingress policy
	}

	rr := doMuxRequest(mux, "PUT", "/v1/ingress/apps/myapp/routes", RouteRequest{
		Routes: []Route{{Name: "x", Hosts: []string{"x.example.com"}, Upstream: "localhost:80"}},
	}, client)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 without ingress policy, got %d", rr.Code)
	}
}

func TestConfigFileContent_Caddy(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)
	client := testClient("acme")

	doMuxRequest(mux, "PUT", "/v1/ingress/apps/web/routes", RouteRequest{
		Routes: []Route{
			{Name: "main", Hosts: []string{"app.example.com"}, Upstream: "localhost:3000", BindAddress: "127.0.0.1"},
			{Name: "api", Hosts: []string{"api.example.com"}, Upstream: "localhost:8000", PathPrefix: "/v1"},
		},
	}, client)

	data, err := os.ReadFile(filepath.Join(configDir, "acme--web.conf"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	content := string(data)

	// Verify header mentions app
	if !contains(content, "app: web") {
		t.Error("config should mention app name in header")
	}

	// Verify route content
	if !contains(content, "app.example.com {") {
		t.Error("expected app.example.com block")
	}
	if !contains(content, "bind 127.0.0.1") {
		t.Error("expected bind directive")
	}
	if !contains(content, "api.example.com {") {
		t.Error("expected api.example.com block")
	}
	if !contains(content, "handle_path /v1*") {
		t.Error("expected handle_path for path prefix")
	}
}

func TestMultipleClients_Isolated(t *testing.T) {
	h, configDir := testHandler(t)
	mux := setupMux(h)

	clientA := testClient("alpha")
	clientB := testClient("beta")

	// Both clients create same app name
	doMuxRequest(mux, "PUT", "/v1/ingress/apps/web/routes", RouteRequest{
		Routes: []Route{{Name: "site", Hosts: []string{"a.example.com"}, Upstream: "localhost:3000"}},
	}, clientA)

	doMuxRequest(mux, "PUT", "/v1/ingress/apps/web/routes", RouteRequest{
		Routes: []Route{{Name: "site", Hosts: []string{"b.example.com"}, Upstream: "localhost:4000"}},
	}, clientB)

	// Separate config files per client
	if _, err := os.Stat(filepath.Join(configDir, "alpha--web.conf")); os.IsNotExist(err) {
		t.Error("expected alpha--web.conf")
	}
	if _, err := os.Stat(filepath.Join(configDir, "beta--web.conf")); os.IsNotExist(err) {
		t.Error("expected beta--web.conf")
	}

	// Deleting alpha's app should not affect beta
	doMuxRequest(mux, "DELETE", "/v1/ingress/apps/web", nil, clientA)
	if _, err := os.Stat(filepath.Join(configDir, "beta--web.conf")); os.IsNotExist(err) {
		t.Error("beta config should survive alpha's delete")
	}
}

func contains(s, substr string) bool {
	return bytes.Contains([]byte(s), []byte(substr))
}

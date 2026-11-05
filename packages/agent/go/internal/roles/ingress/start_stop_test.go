package ingress

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func lifecycleMux(h *Handler) *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("PUT /apps/{app}/routes", h.UpdateAppRoutes)
	m.HandleFunc("GET /apps/{app}/routes", h.ListAppRoutes)
	m.HandleFunc("POST /apps/{app}/stop", h.StopApp)
	m.HandleFunc("POST /apps/{app}/start", h.StartApp)
	m.HandleFunc("DELETE /apps/{app}", h.DeleteApp)
	return m
}
func TestIngressLifecyclePersistsLatestRoutes(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000", PathPrefix: "/api", BindAddress: "127.0.0.1", Headers: map[string]string{"X-Test": "retained"}}}}
	call := func(method, path string, body any) {
		t.Helper()
		r := doMuxRequest(m, method, path, body, client)
		if r.Code != 200 {
			t.Fatalf("%s %s: %d %s", method, path, r.Code, r.Body.String())
		}
	}
	call("PUT", "/apps/demo/routes", routes)
	call("POST", "/apps/demo/stop", nil)
	call("POST", "/apps/demo/stop", nil)
	file := filepath.Join(dir, "tenant--demo.conf")
	assertConfig := func(want, absent string) {
		t.Helper()
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), want) || strings.Contains(string(data), absent) {
			t.Fatalf("unexpected config: %s", data)
		}
	}
	assertConfig(`respond "Environment stopped" 503`, "reverse_proxy")
	data, _ := os.ReadFile(file)
	for _, want := range []string{"handle_path /api*", "bind 127.0.0.1", "header Cache-Control no-store", "X-Content-Type-Options nosniff", "header X-Test"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("missing %q", want)
		}
	}
	// A fresh handler reads persistent stopped state on PUT and Start.
	h2 := NewHandler(h.cfg, h.clientStore, testLogger())
	m = lifecycleMux(h2)
	routes.Routes[0].Upstream = "10.0.0.2:4000"
	call("PUT", "/apps/demo/routes", routes)
	assertConfig(`respond "Environment stopped" 503`, "reverse_proxy")
	call("POST", "/apps/demo/start", nil)
	call("POST", "/apps/demo/start", nil)
	assertConfig("reverse_proxy 10.0.0.2:4000", "Environment stopped")
	call("DELETE", "/apps/demo", nil)
	state, err := h2.driver.(*CaddyDriver).readState("tenant", "demo")
	if err != nil || !state.Deleted {
		t.Fatalf("deletion tombstone missing: %v", err)
	}
}
func TestIngressLifecycleRejectsUnauthorizedUnsupportedAndMissing(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	noRole := testClient("other")
	noRole.Ingress = nil
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, noRole); r.Code != 403 {
		t.Fatal(r.Code)
	}
	if r := doMuxRequest(m, "POST", "/apps/bad%21name/stop", nil, client); r.Code != 400 {
		t.Fatal(r.Code)
	}
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 404 {
		t.Fatal(r.Code)
	}
	h.driver = &TraefikDriver{configDir: dir}
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 501 {
		t.Fatal(r.Code)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("rejection mutated files")
	}
}
func TestIngressLifecycleReloadFailureRetry(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}}
	if r := doMuxRequest(m, "PUT", "/apps/demo/routes", routes, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	d := h.driver.(*CaddyDriver)
	d.reloadCmd = "/bin/false"
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 500 {
		t.Fatal(r.Code)
	}
	fresh := &CaddyDriver{configDir: dir}
	state, err := fresh.readState("tenant", "demo")
	if err != nil || !state.Stopped {
		t.Fatalf("stop state lost: %v", err)
	}
	d.reloadCmd = "/bin/true"
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
}

func TestIngressLifecycleLegacyAndCorruptState(t *testing.T) {
	h, dir := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	if err := os.WriteFile(filepath.Join(dir, "tenant--demo.conf"), []byte("app.example.com {\n reverse_proxy localhost:3000\n}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 409 {
		t.Fatal(r.Code)
	}
	if err := os.WriteFile(filepath.Join(dir, "tenant--demo.state.json"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ method, path string }{{"GET", "/apps/demo/routes"}, {"POST", "/apps/demo/start"}, {"POST", "/apps/demo/stop"}} {
		if r := doMuxRequest(m, entry.method, entry.path, nil, client); r.Code != 500 {
			t.Fatalf("%s: %d", entry.path, r.Code)
		}
	}
}
func TestIngressStartRevalidatesPolicy(t *testing.T) {
	h, _ := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}}
	if r := doMuxRequest(m, "PUT", "/apps/demo/routes", routes, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	client.Ingress.Domains.Allowed = []string{"*.different.example"}
	// Policy restriction must not prevent a safety stop, but must block Start.
	if r := doMuxRequest(m, "POST", "/apps/demo/stop", nil, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	if r := doMuxRequest(m, "POST", "/apps/demo/start", nil, client); r.Code != 400 {
		t.Fatal(r.Code)
	}
	state, err := h.driver.(*CaddyDriver).readState("tenant", "demo")
	if err != nil || !state.Stopped {
		t.Fatalf("failed Start changed state: %v", err)
	}
}

func TestIngressStartupRepairsDurableStopAndDeletion(t *testing.T) {
	h, dir := testHandler(t)
	d := h.driver.(*CaddyDriver)
	routes := []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}
	if err := d.WriteConfig("tenant--nested", "app--nested", routes); err != nil {
		t.Fatal(err)
	}
	state, err := d.readState("tenant--nested", "app--nested")
	if err != nil {
		t.Fatal(err)
	}
	state.Stopped = true
	data, _ := json.Marshal(state)
	if err = os.WriteFile(d.statePath("tenant--nested", "app--nested"), data, 0600); err != nil {
		t.Fatal(err)
	}
	// Simulate death after durable Stop sidecar, before stub rendering/reload.
	fresh := NewHandler(h.cfg, h.clientStore, testLogger())
	config, err := os.ReadFile(d.configPath("tenant--nested", "app--nested"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "reverse_proxy") || !strings.Contains(string(config), "Environment stopped") {
		t.Fatal("startup failed to repair stopped route")
	}
	state.Deleted = true
	data, _ = json.Marshal(state)
	if err = os.WriteFile(d.statePath("tenant--nested", "app--nested"), data, 0600); err != nil {
		t.Fatal(err)
	}
	fresh.Reconcile()
	if _, err = os.Stat(d.configPath("tenant--nested", "app--nested")); !os.IsNotExist(err) {
		t.Fatal("tombstone failed to delete stale config")
	}
	if _, err = os.Stat(filepath.Join(dir, "tenant--nested--app--nested.state.json")); err != nil {
		t.Fatal("tombstone removed before recovery")
	}
}

func TestIngressDeletionTombstoneAndRecreate(t *testing.T) {
	h, _ := testHandler(t)
	m := lifecycleMux(h)
	client := testClient("tenant")
	routes := RouteRequest{Routes: []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}}
	for _, entry := range []struct {
		method, path string
		body         any
	}{{"PUT", "/apps/demo/routes", routes}, {"POST", "/apps/demo/stop", nil}, {"DELETE", "/apps/demo", nil}} {
		if r := doMuxRequest(m, entry.method, entry.path, entry.body, client); r.Code != 200 {
			t.Fatal(r.Code)
		}
	}
	for _, entry := range []struct{ method, path string }{{"GET", "/apps/demo/routes"}, {"POST", "/apps/demo/stop"}, {"POST", "/apps/demo/start"}} {
		if r := doMuxRequest(m, entry.method, entry.path, nil, client); r.Code != 404 {
			t.Fatalf("%s %s: %d", entry.method, entry.path, r.Code)
		}
	}
	if r := doMuxRequest(m, "PUT", "/apps/demo/routes", routes, client); r.Code != 200 {
		t.Fatal(r.Code)
	}
	state, err := h.driver.(*CaddyDriver).readState("tenant", "demo")
	if err != nil || state.Deleted || state.Stopped {
		t.Fatalf("recreated app still deleted/stopped: %v", err)
	}
}
func TestIngressRecoveryReloadRetriesWithoutChurn(t *testing.T) {
	h, dir := testHandler(t)
	d := h.driver.(*CaddyDriver)
	routes := []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000", Headers: map[string]string{"X-B": "b", "X-A": "a"}}}
	state := appIngressState{Routes: routes, Stopped: true}
	if err := d.writeStateConfig("tenant", "demo", state); err != nil {
		t.Fatal(err)
	}
	h.recoveryDirty = true
	d.reloadCmd = "/bin/false"
	h.Reconcile()
	if !h.recoveryDirty {
		t.Fatal("reload failure lost retry intent")
	}
	d.reloadCmd = "/bin/true"
	h.Reconcile()
	if h.recoveryDirty {
		t.Fatal("successful retry still dirty")
	}
	path := d.configPath("tenant", "demo")
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		h.Reconcile()
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatalf("unchanged config rewritten in %s", dir)
	}
}

func TestIngressRecoveryAllowsSafeHistoricalClientNames(t *testing.T) {
	for _, client := range []string{".tenant", strings.Repeat("t", 64)} {
		t.Run(client, func(t *testing.T) {
			h, _ := testHandler(t)
			d := h.driver.(*CaddyDriver)
			routes := []Route{{Name: "web", Hosts: []string{"app.example.com"}, Upstream: "10.0.0.1:3000"}}
			if err := d.WriteConfig(client, "app--demo", routes); err != nil {
				t.Fatal(err)
			}
			state, _ := d.readState(client, "app--demo")
			state.Stopped = true
			data, _ := json.Marshal(state)
			if err := os.WriteFile(d.statePath(client, "app--demo"), data, 0600); err != nil {
				t.Fatal(err)
			}
			NewHandler(h.cfg, h.clientStore, testLogger())
			config, err := os.ReadFile(d.configPath(client, "app--demo"))
			if err != nil || !strings.Contains(string(config), "Environment stopped") {
				t.Fatalf("historical client recovery failed: %v", err)
			}
		})
	}
	for _, bad := range []string{"", ".", "..", "../tenant", "tenant/other", "tenant\\other", "tenant\x00other"} {
		if safeRecoveryClient(bad) {
			t.Errorf("accepted unsafe client %q", bad)
		}
	}
}

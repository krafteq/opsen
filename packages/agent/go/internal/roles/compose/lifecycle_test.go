package compose

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opsen/agent/internal/config"
	"github.com/opsen/agent/internal/identity"
)

func lifecycleRequest(h *Handler, client *config.ClientPolicy, slug, action string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/compose/projects/{project}/stop", h.Stop)
	mux.HandleFunc("POST /v1/compose/projects/{project}/start", h.Start)
	req := httptest.NewRequest("POST", "/v1/compose/projects/"+slug+"/"+action, nil)
	req = req.WithContext(identity.WithClient(req.Context(), client))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func recordCompose(t *testing.T, h *Handler) (string, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "commands")
	fail := filepath.Join(dir, "fail")
	bin := filepath.Join(dir, "docker")
	script := "#!/bin/sh\necho \"$*\" >> '" + log + "'\nif test -f '" + fail + "'; then exit 1; fi\nexit 0\n"
	if err := os.WriteFile(bin, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	h.cfg.Roles.Compose.ComposeBinary = bin
	return log, fail
}

func readCommands(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const lifecycleCompose = "services:\n  web:\n    image: busybox:latest\n    command: sleep 3600\n"

func TestLifecyclePreservesStateAndDefersDeployAcrossRestart(t *testing.T) {
	h, dir := testHandler(t)
	client := minimalClient("tenant")
	log, _ := recordCompose(t, h)
	deploy := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose, "secret.txt": "retained"})
	if deploy.Code != 200 {
		t.Fatalf("deploy %d: %s", deploy.Code, deploy.Body)
	}
	for i := 0; i < 2; i++ {
		rr := lifecycleRequest(h, client, "web", "stop")
		if rr.Code != 200 {
			t.Fatalf("stop: %d %s", rr.Code, rr.Body)
		}
	}
	if err := os.WriteFile(log, nil, 0644); err != nil {
		t.Fatal(err)
	}
	// New handler loads stopped state, with shared operation locking with its reconciler.
	restarted := NewHandler(h.cfg, h.clientStore, testLogger())
	changed := strings.Replace(lifecycleCompose, "busybox:latest", "busybox:1.37", 1)
	deploy = deployProject(t, restarted, client, "web", map[string]string{"compose.yml": changed})
	if deploy.Code != 200 {
		t.Fatalf("deferred deploy %d: %s", deploy.Code, deploy.Body)
	}
	var response DeployResponse
	if err := json.Unmarshal(deploy.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Stopped || response.Status != "stopped" {
		t.Fatalf("response %+v", response)
	}
	if got := readCommands(t, log); got != "" {
		t.Fatalf("deferred deploy invoked docker: %s", got)
	}
	restarted.Reconciler().redeployProject(client.Client, client, "web", "new-policy")
	if got := readCommands(t, log); strings.Contains(got, "up ") {
		t.Fatalf("reconciler restarted workload: %s", got)
	}
	rr := lifecycleRequest(restarted, client, "web", "start")
	if rr.Code != 200 {
		t.Fatalf("start: %d %s", rr.Code, rr.Body)
	}
	if got := readCommands(t, log); !strings.Contains(got, "up -d") || strings.Contains(got, "down") {
		t.Fatalf("commands: %s", got)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "tenant", "web", "secret.txt")); err != nil || string(data) != "retained" {
		t.Fatalf("retained file %s %v", data, err)
	}
	state, err := LoadResourceTracker(filepath.Join(dir, "resource-state.json"), testLogger())
	if err != nil || state.GetProject("tenant", "web").Stopped {
		t.Fatalf("started state not durable: %v", err)
	}
}

func TestLifecycleUnchangedStartUsesExistingContainers(t *testing.T) {
	h, _ := testHandler(t)
	client := minimalClient("tenant")
	log, _ := recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if rr := lifecycleRequest(h, client, "web", "stop"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	os.WriteFile(log, nil, 0644)
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if got := readCommands(t, log); !strings.Contains(got, " up -d") || strings.Contains(got, "down") {
		t.Fatalf("start must preserve container identities: %s", got)
	}
}

func TestLifecycleFailuresStayStoppedAndRetry(t *testing.T) {
	h, _ := testHandler(t)
	client := minimalClient("tenant")
	log, fail := recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	os.WriteFile(fail, nil, 0644)
	if rr := lifecycleRequest(h, client, "web", "stop"); rr.Code != 500 {
		t.Fatalf("expected stop failure: %d", rr.Code)
	}
	if !h.tracker.GetProject("tenant", "web").Stopped {
		t.Fatal("stop intent lost on failure")
	}
	os.Remove(fail)
	if rr := lifecycleRequest(h, client, "web", "stop"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	os.WriteFile(fail, nil, 0644)
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 500 {
		t.Fatalf("expected start failure: %d %s", rr.Code, rr.Body)
	}
	if !h.tracker.GetProject("tenant", "web").Stopped {
		t.Fatal("failed start changed desired state")
	}
	os.Remove(fail)
	// Persistence failure must abort before Docker runs.
	h.tracker.path = filepath.Join(t.TempDir(), "missing", "state.json")
	os.WriteFile(log, nil, 0644)
	if rr := lifecycleRequest(h, client, "web", "stop"); rr.Code != 500 {
		t.Fatalf("expected persistence failure: %d", rr.Code)
	}
	if got := readCommands(t, log); got != "" {
		t.Fatalf("Docker invoked before persistence: %s", got)
	}
}

func TestLifecycleAuthorizationIsolationAndCurrentPolicy(t *testing.T) {
	h, _ := testHandler(t)
	client := minimalClient("tenant")
	recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if rr := lifecycleRequest(h, &config.ClientPolicy{Client: "tenant"}, "web", "stop"); rr.Code != 403 {
		t.Fatalf("expected forbidden %d", rr.Code)
	}
	if rr := lifecycleRequest(h, minimalClient("other"), "web", "stop"); rr.Code != 404 {
		t.Fatalf("expected not found %d", rr.Code)
	}
	if rr := lifecycleRequest(h, client, "bad!slug", "stop"); rr.Code != 400 {
		t.Fatalf("expected bad slug %d", rr.Code)
	}
	lifecycleRequest(h, client, "web", "stop")
	client.Compose.Images.AllowedRegistries = []string{"private.example"}
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 400 {
		t.Fatalf("current policy ignored: %d %s", rr.Code, rr.Body)
	}
	if !h.tracker.GetProject("tenant", "web").Stopped {
		t.Fatal("policy rejection lost stopped state")
	}
}

func TestIncompleteDeferredDeploymentFailsClosedAcrossRestart(t *testing.T) {
	h, dir := testHandler(t)
	client := minimalClient("tenant")
	log, _ := recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if rr := lifecycleRequest(h, client, "web", "stop"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	// Fail the source-input write AFTER a hardened compose update was written.
	source := filepath.Join(dir, "tenant", "web", sourceComposeFile)
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(source, 0750); err != nil {
		t.Fatal(err)
	}
	changed := strings.Replace(lifecycleCompose, "busybox:latest", "busybox:1.37", 1)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": changed}); rr.Code != 500 {
		t.Fatalf("expected source write failure: %d %s", rr.Code, rr.Body)
	}
	restarted := NewHandler(h.cfg, h.clientStore, testLogger())
	if !restarted.tracker.GetProject("tenant", "web").PendingInvalid {
		t.Fatal("incomplete deployment marker not durable")
	}
	os.WriteFile(log, nil, 0644)
	if rr := lifecycleRequest(restarted, client, "web", "start"); rr.Code != 409 {
		t.Fatalf("incomplete deployment started: %d %s", rr.Code, rr.Body)
	}
	if got := readCommands(t, log); got != "" {
		t.Fatalf("incomplete deployment invoked Docker: %s", got)
	}
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if rr := deployProject(t, restarted, client, "web", map[string]string{"compose.yml": changed}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if restarted.tracker.GetProject("tenant", "web").PendingInvalid {
		t.Fatal("successful retry did not clear invalid marker")
	}
	if rr := lifecycleRequest(restarted, client, "web", "start"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
}

func TestStartRechecksAndUpdatesCurrentBudget(t *testing.T) {
	h, _ := testHandler(t)
	client := minimalClient("tenant")
	client.Compose.PerContainer.DefaultMemoryMb = 64
	client.Compose.MaxMemoryMb = 128
	log, _ := recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if rr := lifecycleRequest(h, client, "web", "stop"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	client.Compose.PerContainer.DefaultMemoryMb = 256
	os.WriteFile(log, nil, 0644)
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 400 {
		t.Fatalf("expected current budget failure: %d %s", rr.Code, rr.Body)
	}
	if got := readCommands(t, log); got != "" {
		t.Fatalf("over-budget start invoked Docker: %s", got)
	}
	client.Compose.MaxMemoryMb = 512
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if got := h.tracker.GetProject("tenant", "web").MemoryMb; got != 256 {
		t.Fatalf("reservation %d, want 256", got)
	}
	// A reconciliation queued before Start must not up the newly started project again.
	os.WriteFile(log, nil, 0644)
	h.Reconciler().redeployProject(client.Client, client, "web", policyHash(client, h.cfg))
	if got := readCommands(t, log); got != "" {
		t.Fatalf("stale queued reconcile invoked Docker: %s", got)
	}
}

func TestCorruptStateNeverStartsProjects(t *testing.T) {
	h, dir := testHandler(t)
	client := minimalClient("tenant")
	log, _ := recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if err := os.WriteFile(filepath.Join(dir, "resource-state.json"), []byte("broken state"), 0640); err != nil {
		t.Fatal(err)
	}
	restarted := NewHandler(h.cfg, h.clientStore, testLogger())
	os.WriteFile(log, nil, 0644)
	if rr := lifecycleRequest(restarted, client, "web", "start"); rr.Code != 500 {
		t.Fatalf("corrupt state accepted: %d", rr.Code)
	}
	if rr := deployProject(t, restarted, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 500 {
		t.Fatalf("corrupt state deploy accepted: %d", rr.Code)
	}
	restarted.Reconciler().reconcile()
	if got := readCommands(t, log); got != "" {
		t.Fatalf("corrupt state invoked Docker: %s", got)
	}
}

func TestLifecycleCanonicalConfigurationAndStartReassertsRunningState(t *testing.T) {
	h, dir := testHandler(t)
	client := minimalClient("tenant")
	log, _ := recordCompose(t, h)
	if rr := deployProject(t, h, client, "web", map[string]string{"compose.yml": lifecycleCompose}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	latest := strings.Replace(lifecycleCompose, "web:", "current:", 1)
	if rr := deployProject(t, h, client, "web", map[string]string{"docker-compose.yml": latest}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	selected := findComposeFileOnDisk(filepath.Join(dir, client.Client, "web"))
	if filepath.Base(selected) != managedComposeFile {
		t.Fatalf("selected stale file: %s", selected)
	}
	if data, err := os.ReadFile(selected); err != nil || !strings.Contains(string(data), "current:") {
		t.Fatalf("canonical config stale: %s %v", data, err)
	}
	os.WriteFile(log, nil, 0644)
	// A Start must reassert Docker state even if durable intent is already running.
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if got := readCommands(t, log); !strings.Contains(got, "up -d") {
		t.Fatalf("Start did not reassert running state: %s", got)
	}
	// A failed policy revalidation must not stop a previously running workload.
	client.Compose.Images.AllowedRegistries = []string{"private.example"}
	os.WriteFile(log, nil, 0644)
	if rr := lifecycleRequest(h, client, "web", "start"); rr.Code != 400 {
		t.Fatalf("expected policy rejection: %d %s", rr.Code, rr.Body)
	}
	if got := readCommands(t, log); got != "" {
		t.Fatalf("running workload changed after rejection: %s", got)
	}
}

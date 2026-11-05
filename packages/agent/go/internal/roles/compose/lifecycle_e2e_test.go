//go:build e2e

package compose

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/opsen/agent/internal/config"
)

func TestE2E_StopStartPreservesContainersPortsAndVolumes(t *testing.T) {
	requireDocker(t)
	h, _ := testHandler(t)
	h.cfg.Roles.Compose.ComposeBinary = "docker compose"
	h.cfg.GlobalHardening = config.GlobalHardening{}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	if err := os.MkdirAll(h.cfg.Roles.Compose.DeploymentsDir, 0750); err != nil {
		t.Fatal(err)
	}
	h.cfg.Roles.Compose.PortRange = fmt.Sprintf("%d-%d", port, port)
	h.ports, err = NewPortAllocator(filepath.Join(h.cfg.Roles.Compose.DeploymentsDir, "port-state.json"), h.cfg.Roles.Compose.PortRange, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	client := minimalClient("lifecycle-e2e")
	client.Compose.Network.IngressBindAddress = "127.0.0.1"
	slug := fmt.Sprintf("test-%d", time.Now().UnixNano())
	container := "opsen-" + client.Client + "-" + slug + "-web-1"
	yaml := `services:
  web:
    image: busybox:latest
    stop_grace_period: 1s
    command: ["sh", "-c", "echo $$VALUE > /data/value; exec sleep 3600"]
    environment:
      VALUE: initial
    expose: ["8080"]
    volumes: ["data:/data"]
volumes:
  data: {}
`
	t.Cleanup(func() {
		rr := destroyProject(t, h, client, slug)
		if rr.Code != 200 {
			t.Logf("cleanup %d %s", rr.Code, rr.Body)
		}
	})
	if rr := deployProject(t, h, client, slug, map[string]string{"compose.yml": yaml}); rr.Code != 200 {
		t.Fatalf("deploy: %d %s", rr.Code, rr.Body)
	}
	id := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.Id}}", container))
	dockerOutput(t, "exec", container, "sh", "-c", "echo retained > /data/sentinel")
	allocation := h.ports.GetProject(client.Client, slug).Ports[0].HostPort
	if rr := lifecycleRequest(h, client, slug, "stop"); rr.Code != 200 {
		t.Fatalf("stop: %d %s", rr.Code, rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.State.Running}}", container)); got != "false" {
		t.Fatalf("stop left container running %s", got)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.Id}}", container)); got != id {
		t.Fatal("Stop replaced container")
	}
	if rr := lifecycleRequest(h, client, slug, "start"); rr.Code != 200 {
		t.Fatalf("start: %d %s", rr.Code, rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.Id}}", container)); got != id {
		t.Fatal("unchanged Start replaced container")
	}
	if got := strings.TrimSpace(dockerOutput(t, "exec", container, "cat", "/data/sentinel")); got != "retained" {
		t.Fatalf("volume data lost: %s", got)
	}
	if rr := lifecycleRequest(h, client, slug, "stop"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	// Agent restart and a staged deployment retain state and port reservations.
	restarted := NewHandler(h.cfg, h.clientStore, testLogger())
	next := strings.Replace(yaml, "VALUE: initial", "VALUE: latest", 1)
	if rr := deployProject(t, restarted, client, slug, map[string]string{"compose.yml": next}); rr.Code != 200 {
		t.Fatalf("staged deploy: %d %s", rr.Code, rr.Body)
	}
	restarted.Reconciler().redeployProject(client.Client, client, slug, "new-policy")
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.State.Running}}", container)); got != "false" {
		t.Fatal("staged deploy/reconcile restarted container")
	}
	if rr := lifecycleRequest(restarted, client, slug, "start"); rr.Code != 200 {
		t.Fatalf("start latest: %d %s", rr.Code, rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "exec", container, "cat", "/data/value")); got != "latest" {
		t.Fatalf("latest config not applied: %s", got)
	}
	if got := strings.TrimSpace(dockerOutput(t, "exec", container, "cat", "/data/sentinel")); got != "retained" {
		t.Fatalf("volume data lost on changed config: %s", got)
	}
	if got := restarted.ports.GetProject(client.Client, slug).Ports[0].HostPort; got != allocation {
		t.Fatalf("port changed %d -> %d", allocation, got)
	}
	// Source compose is agent-private, like the hardened compose containing secrets.
	if info, err := os.Stat(filepath.Join(h.cfg.Roles.Compose.DeploymentsDir, client.Client, slug, sourceComposeFile)); err != nil || info.Mode().Perm()&0007 != 0 {
		t.Fatalf("source permissions %v %v", info, err)
	}
}

func TestE2E_StopAfterComposeFilenameAndServiceChange(t *testing.T) {
	requireDocker(t)
	h, _ := testHandler(t)
	h.cfg.Roles.Compose.ComposeBinary = "docker compose"
	h.cfg.GlobalHardening = config.GlobalHardening{}
	client := minimalClient("filename-e2e")
	slug := fmt.Sprintf("test-%d", time.Now().UnixNano())
	name := func(service string) string { return "opsen-" + client.Client + "-" + slug + "-" + service + "-1" }
	content := func(service string) string {
		return fmt.Sprintf("services:\n  %s:\n    image: busybox:latest\n    command: sleep 3600\n    stop_grace_period: 1s\n", service)
	}
	t.Cleanup(func() {
		rr := destroyProject(t, h, client, slug)
		if rr.Code != 200 {
			t.Logf("cleanup %d %s", rr.Code, rr.Body)
		}
	})
	if rr := deployProject(t, h, client, slug, map[string]string{"compose.yml": content("old")}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if rr := deployProject(t, h, client, slug, map[string]string{"docker-compose.yml": content("current")}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	// A leftover caller filename is no longer authoritative and may be invalid.
	if err := os.WriteFile(filepath.Join(h.cfg.Roles.Compose.DeploymentsDir, client.Client, slug, "compose.yml"), []byte("invalid: ["), 0640); err != nil {
		t.Fatal(err)
	}
	if rr := lifecycleRequest(h, client, slug, "stop"); rr.Code != 200 {
		t.Fatalf("stop renamed file: %d %s", rr.Code, rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.State.Running}}", name("current"))); got != "false" {
		t.Fatal("Stop left current service running")
	}
	// Rename both the file and service again while stopped. Start must apply latest.
	if rr := deployProject(t, h, client, slug, map[string]string{"compose.yaml": content("latest")}); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if rr := lifecycleRequest(h, client, slug, "start"); rr.Code != 200 {
		t.Fatalf("start renamed staged file: %d %s", rr.Code, rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.State.Running}}", name("latest"))); got != "true" {
		t.Fatal("latest service missing")
	}
	// Self-heal Docker drift even when persisted state is already running.
	dockerOutput(t, "stop", "-t", "1", name("latest"))
	if rr := lifecycleRequest(h, client, slug, "start"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.State.Running}}", name("latest"))); got != "true" {
		t.Fatal("Start did not restore externally stopped container")
	}
	dockerOutput(t, "rm", "-f", name("latest"))
	if rr := lifecycleRequest(h, client, slug, "start"); rr.Code != 200 {
		t.Fatal(rr.Body)
	}
	if got := strings.TrimSpace(dockerOutput(t, "inspect", "-f", "{{.State.Running}}", name("latest"))); got != "true" {
		t.Fatal("Start did not restore externally removed container")
	}
}

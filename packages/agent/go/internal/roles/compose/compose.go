package compose

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/opsen/agent/internal/config"
	"gopkg.in/yaml.v3"
)

// chownSidecarSuffix is appended to a service name to form its ephemeral
// volume-ownership init sidecar. The suffix is reserved against user-authored
// service names (see validateCompose); generated sidecars are identified for
// stripping by chownSidecarLabel, not by this suffix.
const chownSidecarSuffix = "-opsen-chown-init"

// chownSidecarLabel marks a service as an agent-generated chown-init sidecar.
// It is the authoritative signal used to find and strip previously-injected
// sidecars on re-harden, and doubles as an audit handle (e.g.
// `docker ps --filter label=opsen.generated=chown-init`).
const (
	chownSidecarLabel      = "opsen.generated"
	chownSidecarLabelValue = "chown-init"
)

// defaultChownInitImage is the image used for the ownership init sidecar when
// GlobalHardening.ChownInitImage is unset. busybox provides a numeric-id chown.
const defaultChownInitImage = "busybox"

// ComposeFile represents a parsed docker-compose.yml.
type ComposeFile struct {
	Services map[string]*ComposeService `yaml:"services"`
	Networks map[string]any             `yaml:"networks,omitempty"`
	Volumes  map[string]any             `yaml:"volumes,omitempty"`
	raw      map[string]any
}

// ComposeService represents a single service in a compose file.
type ComposeService struct {
	Image           string            `yaml:"image,omitempty"`
	Build           any               `yaml:"build,omitempty"`
	Command         any               `yaml:"command,omitempty"`
	Environment     any               `yaml:"environment,omitempty"`
	EnvFile         any               `yaml:"env_file,omitempty"`
	Ports           []string          `yaml:"ports,omitempty"`
	Volumes         []string          `yaml:"volumes,omitempty"`
	Networks        any               `yaml:"networks,omitempty"`
	DependsOn       any               `yaml:"depends_on,omitempty"`
	Restart         string            `yaml:"restart,omitempty"`
	Healthcheck     any               `yaml:"healthcheck,omitempty"`
	Labels          map[string]string `yaml:"labels,omitempty"`
	Deploy          any               `yaml:"deploy,omitempty"`
	Privileged      *bool             `yaml:"privileged,omitempty"`
	NetworkMode     string            `yaml:"network_mode,omitempty"`
	PidMode         string            `yaml:"pid,omitempty"`
	IpcMode         string            `yaml:"ipc,omitempty"`
	UsernsMode      string            `yaml:"userns_mode,omitempty"`
	User            string            `yaml:"user,omitempty"`
	ReadOnly        *bool             `yaml:"read_only,omitempty"`
	SecurityOpt     []string          `yaml:"security_opt,omitempty"`
	CapAdd          []string          `yaml:"cap_add,omitempty"`
	CapDrop         []string          `yaml:"cap_drop,omitempty"`
	Tmpfs           any               `yaml:"tmpfs,omitempty"`
	PidsLimit       *int              `yaml:"pids_limit,omitempty"`
	MemLimit        string            `yaml:"mem_limit,omitempty"`
	Cpus            any               `yaml:"cpus,omitempty"`
	StopSignal      string            `yaml:"stop_signal,omitempty"`
	StopGracePeriod string            `yaml:"stop_grace_period,omitempty"`
	Logging         any               `yaml:"logging,omitempty"`
	Expose          []string          `yaml:"expose,omitempty"`
	ExtraHosts      []string          `yaml:"extra_hosts,omitempty"`
	Entrypoint      any               `yaml:"entrypoint,omitempty"`
	WorkingDir      string            `yaml:"working_dir,omitempty"`

	raw map[string]any
}

func parseCompose(data []byte) (*ComposeFile, error) {
	var rawMap map[string]any
	if err := yaml.Unmarshal(data, &rawMap); err != nil {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}

	compose := &ComposeFile{raw: rawMap}
	if err := yaml.Unmarshal(data, compose); err != nil {
		return nil, fmt.Errorf("invalid compose file: %w", err)
	}

	if len(compose.Services) == 0 {
		return nil, fmt.Errorf("no services defined")
	}

	return compose, nil
}

func marshalCompose(compose *ComposeFile) ([]byte, error) {
	return yaml.Marshal(compose)
}

// validateCompose checks the compose file against deny-list and client policies.
// This validates the SINGLE compose file. Cross-project budget checks happen in the tracker.
func validateCompose(compose *ComposeFile, cfg *config.AgentConfig, policy *config.ComposePolicy) []string {
	var violations []string

	// Service count per project
	if policy.MaxServices > 0 && len(compose.Services) > policy.MaxServices {
		violations = append(violations, fmt.Sprintf("too many services: %d (max %d)", len(compose.Services), policy.MaxServices))
	}

	for name, svc := range compose.Services {
		// The chown-init sidecar suffix is reserved for agent-generated helpers.
		// Reject user services using it so hardening never silently removes one
		// (and so generated sidecar names can't collide with a user service).
		if strings.HasSuffix(name, chownSidecarSuffix) {
			violations = append(violations, fmt.Sprintf("service %s: name suffix '%s' is reserved for agent-generated helpers", name, chownSidecarSuffix))
		}

		if svc.Privileged != nil && *svc.Privileged && cfg.Deny.Privileged {
			violations = append(violations, fmt.Sprintf("service %s: privileged mode not allowed", name))
		}

		for _, denied := range cfg.Deny.NetworkModes {
			if svc.NetworkMode == denied {
				violations = append(violations, fmt.Sprintf("service %s: network_mode '%s' not allowed", name, svc.NetworkMode))
			}
		}

		if svc.PidMode == cfg.Deny.PidMode {
			violations = append(violations, fmt.Sprintf("service %s: pid mode '%s' not allowed", name, svc.PidMode))
		}

		if svc.IpcMode == cfg.Deny.IpcMode {
			violations = append(violations, fmt.Sprintf("service %s: ipc mode '%s' not allowed", name, svc.IpcMode))
		}

		if svc.UsernsMode == "host" {
			violations = append(violations, fmt.Sprintf("service %s: userns_mode 'host' not allowed", name))
		}

		if svc.Build != nil && !policy.AllowBuild {
			violations = append(violations, fmt.Sprintf("service %s: build not allowed", name))
		}

		if svc.EnvFile != nil && !policy.AllowEnvFile {
			violations = append(violations, fmt.Sprintf("service %s: env_file not allowed (use inline environment)", name))
		}

		for _, vol := range svc.Volumes {
			hostPath := extractHostPath(vol)
			if hostPath != "" {
				if isBlockedPath(hostPath, cfg.Deny.HostPaths) {
					violations = append(violations, fmt.Sprintf("service %s: host path '%s' not allowed", name, hostPath))
				} else if !isAllowedPath(hostPath, policy.Volumes.AllowedHostPaths) {
					violations = append(violations, fmt.Sprintf("service %s: host path '%s' not in allowed paths", name, hostPath))
				}
			}
		}

		for _, cap := range svc.CapAdd {
			if !isAllowedCapability(cap, policy.Capabilities.Allowed) {
				violations = append(violations, fmt.Sprintf("service %s: capability '%s' not allowed", name, cap))
			}
		}

		if svc.Image != "" && len(policy.Images.AllowedRegistries) > 0 {
			if !isAllowedImage(svc.Image, policy.Images.AllowedRegistries) {
				violations = append(violations, fmt.Sprintf("service %s: image '%s' not from allowed registry", name, svc.Image))
			}
		}

		if svc.Image != "" && len(policy.Images.DenyTags) > 0 {
			tag := extractTag(svc.Image)
			for _, denied := range policy.Images.DenyTags {
				if tag == denied {
					violations = append(violations, fmt.Sprintf("service %s: image tag '%s' not allowed", name, tag))
				}
			}
		}

		// Per-container resource checks
		mem := parseMemoryMb(svc.MemLimit)
		if mem == 0 {
			mem = policy.PerContainer.DefaultMemoryMb
		}
		if policy.PerContainer.MaxMemoryMb > 0 && mem > policy.PerContainer.MaxMemoryMb {
			violations = append(violations, fmt.Sprintf("service %s: memory %dMB exceeds per-container max %dMB", name, mem, policy.PerContainer.MaxMemoryMb))
		}

		cpus := parseCpus(svc.Cpus)
		if cpus == 0 {
			cpus = policy.PerContainer.DefaultCpus
		}
		if policy.PerContainer.MaxCpus > 0 && cpus > policy.PerContainer.MaxCpus {
			violations = append(violations, fmt.Sprintf("service %s: cpus %.1f exceeds per-container max %.1f", name, cpus, policy.PerContainer.MaxCpus))
		}

		if svc.PidsLimit != nil && *svc.PidsLimit <= 0 {
			violations = append(violations, fmt.Sprintf("service %s: pids_limit must be > 0", name))
		} else {
			pids := effectivePidsLimit(svc, cfg, policy)
			if policy.PerContainer.MaxPids > 0 && pids > policy.PerContainer.MaxPids {
				violations = append(violations, fmt.Sprintf("service %s: pids limit %d exceeds per-container max %d", name, pids, policy.PerContainer.MaxPids))
			}
		}
	}

	return violations
}

func effectivePidsLimit(svc *ComposeService, cfg *config.AgentConfig, policy *config.ComposePolicy) int {
	if svc.PidsLimit != nil {
		return *svc.PidsLimit
	}
	if policy != nil && policy.PerContainer.DefaultPids > 0 {
		return policy.PerContainer.DefaultPids
	}
	if cfg != nil && cfg.GlobalHardening.PidLimit > 0 {
		return cfg.GlobalHardening.PidLimit
	}
	return config.DefaultPidLimit
}

// hardenCompose injects security defaults into all services.
// portMappings are injected as host port bindings (from expose → allocated ports).
// Each project gets its own internal network so projects are isolated by default;
// cross-project communication must go through ingress.
func hardenCompose(compose *ComposeFile, cfg *config.AgentConfig, client *config.ClientPolicy, projectSlug string, portMappings []PortMapping) []string {
	var modifications []string
	hardening := cfg.GlobalHardening
	networkName := fmt.Sprintf("opsen-%s-%s-internal", client.Client, projectSlug)

	// Drop any chown-init sidecars (and the depends_on edges pointing at them)
	// from a previously-hardened compose so re-hardening is idempotent — they are
	// regenerated from scratch below against the current policy and volume set.
	// Sidecars are identified by the agent-owned marker label, NOT by name suffix,
	// so a user-authored service that merely shares the name shape is never touched
	// (the suffix itself is reserved against user services in validateCompose).
	removedSidecars := make(map[string]bool)
	for name, svc := range compose.Services {
		if isGeneratedChownSidecar(svc) {
			removedSidecars[name] = true
			delete(compose.Services, name)
		}
	}
	if len(removedSidecars) > 0 {
		for _, svc := range compose.Services {
			svc.DependsOn = stripDependenciesOn(svc.DependsOn, removedSidecars)
		}
	}

	// Build a lookup of allocated ports by service name
	bindAddr := ""
	if client.Compose != nil {
		bindAddr = client.Compose.Network.IngressBindAddress
	}
	svcPorts := make(map[string][]PortMapping)
	for _, m := range portMappings {
		svcPorts[m.Service] = append(svcPorts[m.Service], m)
	}

	for name, svc := range compose.Services {
		// Strip client-specified ports — the agent owns host port bindings
		if len(svc.Ports) > 0 {
			svc.Ports = nil
			modifications = append(modifications, fmt.Sprintf("%s: removed client ports (agent manages port allocation)", name))
		}

		// Inject allocated port bindings from expose entries
		if mappings, ok := svcPorts[name]; ok {
			for _, m := range mappings {
				binding := fmt.Sprintf("%s:%d:%s", bindAddr, m.HostPort, m.ContainerPort)
				svc.Ports = append(svc.Ports, binding)
			}
			modifications = append(modifications, fmt.Sprintf("%s: allocated host ports from expose", name))
		}

		// Clear expose — it has been converted to port bindings
		svc.Expose = nil

		if hardening.NoNewPrivileges {
			if !containsString(svc.SecurityOpt, "no-new-privileges:true") {
				svc.SecurityOpt = append(svc.SecurityOpt, "no-new-privileges:true")
				modifications = append(modifications, fmt.Sprintf("%s: injected no-new-privileges", name))
			}
		}

		if hardening.CapDropAll {
			svc.CapDrop = []string{"ALL"}
			modifications = append(modifications, fmt.Sprintf("%s: set cap_drop ALL", name))
		}

		if client.Compose != nil && len(svc.CapAdd) > 0 {
			var filtered []string
			for _, cap := range svc.CapAdd {
				if isAllowedCapability(cap, client.Compose.Capabilities.Allowed) {
					filtered = append(filtered, cap)
				} else {
					modifications = append(modifications, fmt.Sprintf("%s: removed cap_add %s", name, cap))
				}
			}
			svc.CapAdd = filtered
		}

		if hardening.ReadOnlyRootfs {
			ro := true
			svc.ReadOnly = &ro
			modifications = append(modifications, fmt.Sprintf("%s: set read_only true", name))
		}

		if len(hardening.DefaultTmpfs) > 0 || svc.Tmpfs != nil {
			defaultPaths := make(map[string]bool)
			var merged []string

			for _, t := range hardening.DefaultTmpfs {
				entry := t.Path
				if t.Options != "" {
					entry += ":" + t.Options
				}
				defaultPaths[t.Path] = true
				merged = append(merged, entry)
			}

			for _, entry := range parseTmpfsEntries(svc.Tmpfs) {
				path := strings.SplitN(entry, ":", 2)[0]
				if !defaultPaths[path] {
					merged = append(merged, entry)
				}
			}

			svc.Tmpfs = merged
			modifications = append(modifications, fmt.Sprintf("%s: set tmpfs", name))
		}

		if svc.PidsLimit == nil {
			limit := effectivePidsLimit(svc, cfg, client.Compose)
			svc.PidsLimit = &limit
			modifications = append(modifications, fmt.Sprintf("%s: set pids_limit %d", name, limit))
		}

		if hardening.DefaultUser != "" && svc.User == "" {
			svc.User = hardening.DefaultUser
			modifications = append(modifications, fmt.Sprintf("%s: set user %s", name, hardening.DefaultUser))
		}

		if client.Compose != nil && svc.MemLimit == "" && client.Compose.PerContainer.DefaultMemoryMb > 0 {
			svc.MemLimit = fmt.Sprintf("%dm", client.Compose.PerContainer.DefaultMemoryMb)
			modifications = append(modifications, fmt.Sprintf("%s: set mem_limit %s", name, svc.MemLimit))
		}

		// Remove deploy.resources.limits to avoid conflicts with top-level limits
		// (docker compose v5+ rejects having both deploy limits and top-level limits)
		if svc.Deploy != nil {
			svc.Deploy = nil
			modifications = append(modifications, fmt.Sprintf("%s: removed deploy section (using top-level limits)", name))
		}

		if svc.Privileged != nil && *svc.Privileged {
			f := false
			svc.Privileged = &f
			modifications = append(modifications, fmt.Sprintf("%s: removed privileged", name))
		}

		svc.NetworkMode = ""
		svc.PidMode = ""
		svc.IpcMode = ""
		svc.UsernsMode = ""

		svc.Logging = map[string]any{
			"driver": "json-file",
			"options": map[string]string{
				"max-size": "10m",
				"max-file": "3",
			},
		}
	}

	// Volume ownership: a hardened service runs as a non-root user under a
	// read-only rootfs, but Docker initializes a fresh named volume as
	// root:root 0755, so the injected user gets EACCES on its own declared
	// volume. For each hardened non-root service that mounts named volumes,
	// inject an ephemeral `user: "0:0"` sidecar that `chown -R`s those mounts
	// to the service's uid:gid and exits before the app starts (wired via
	// depends_on/service_completed_successfully). This keeps root + CHOWN in a
	// short-lived sidecar instead of the always-on, network-exposed service —
	// so "run non-root" and "mount a writable volume" stop being mutually
	// exclusive and `elevated`/`privileged` is no longer needed as a workaround.
	//
	// The sidecar is built here, AFTER the per-service hardening loop, so the
	// agent's own `cap_drop: ALL` and CapAdd allow-list filter (which would
	// strip the CHOWN capability) and the read-only rootfs do not apply to it.
	initImage := hardening.ChownInitImage
	if initImage == "" {
		initImage = defaultChownInitImage
	}
	sidecars := make(map[string]*ComposeService)
	for name, svc := range compose.Services {
		ownership, ok := chownTarget(svc.User)
		if !ok {
			continue
		}
		mounts := namedVolumeMounts(svc.Volumes)
		if len(mounts) == 0 {
			continue
		}

		targets := make([]string, len(mounts))
		for i, m := range mounts {
			targets[i] = m.target
		}
		volumeMounts := make([]string, len(mounts))
		for i, m := range mounts {
			volumeMounts[i] = m.source + ":" + m.target
		}

		sidecarName := name + chownSidecarSuffix
		sidecars[sidecarName] = buildChownSidecar(initImage, ownership, volumeMounts, targets)
		svc.DependsOn = addCompletedDependency(svc.DependsOn, sidecarName)
		modifications = append(modifications, fmt.Sprintf("%s: injected %s ownership init sidecar (chown %s)", name, sidecarName, ownership))
	}
	for n, sc := range sidecars {
		compose.Services[n] = sc
	}

	internal := true
	if client.Compose != nil && client.Compose.Network.InternetAccess {
		internal = false
	}

	compose.Networks = map[string]any{
		"default": map[string]any{
			"name":     networkName,
			"internal": internal,
		},
	}

	for _, svc := range compose.Services {
		svc.Networks = nil
	}

	return modifications
}

func extractHostPath(volume string) string {
	if !strings.Contains(volume, "/") && !strings.HasPrefix(volume, ".") {
		return ""
	}
	parts := strings.SplitN(volume, ":", 2)
	if len(parts) < 2 {
		return ""
	}
	return parts[0]
}

func isBlockedPath(path string, blocked []string) bool {
	for _, b := range blocked {
		if path == b || strings.HasPrefix(path, b+"/") {
			return true
		}
	}
	return false
}

func isAllowedPath(path string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if strings.HasPrefix(path, a) {
			return true
		}
	}
	return false
}

func isAllowedCapability(cap string, allowed []string) bool {
	cap = strings.ToUpper(cap)
	for _, a := range allowed {
		if strings.ToUpper(a) == cap {
			return true
		}
	}
	return false
}

func isAllowedImage(image string, registries []string) bool {
	for _, reg := range registries {
		if strings.HasPrefix(image, reg+"/") || strings.HasPrefix(image, reg+":") {
			return true
		}
		if reg == "docker.io/library" && !strings.Contains(image, "/") {
			return true
		}
	}
	return false
}

func extractTag(image string) string {
	if strings.Contains(image, "@") {
		return ""
	}
	parts := strings.SplitN(image, ":", 2)
	if len(parts) < 2 {
		return "latest"
	}
	return parts[1]
}

// parseTmpfsEntries extracts tmpfs mount strings from the any-typed Tmpfs field.
// Docker Compose accepts tmpfs as a single string or a list of strings.
func parseTmpfsEntries(v any) []string {
	if v == nil {
		return nil
	}
	switch val := v.(type) {
	case string:
		return []string{val}
	case []string:
		return val
	case []any:
		var entries []string
		for _, item := range val {
			if s, ok := item.(string); ok {
				entries = append(entries, s)
			}
		}
		return entries
	}
	return nil
}

func parseMemoryMb(mem string) int {
	if mem == "" {
		return 0
	}
	mem = strings.ToLower(strings.TrimSpace(mem))

	if strings.HasSuffix(mem, "g") {
		var n int
		fmt.Sscanf(strings.TrimSuffix(mem, "g"), "%d", &n)
		return n * 1024
	}
	if strings.HasSuffix(mem, "m") {
		var n int
		fmt.Sscanf(strings.TrimSuffix(mem, "m"), "%d", &n)
		return n
	}
	return 0
}

func containsString(slice []string, s string) bool {
	for _, item := range slice {
		if item == s {
			return true
		}
	}
	return false
}

// volumeMount is a parsed named-volume mount: the volume name and its
// container-side mount path.
type volumeMount struct {
	source string
	target string
}

// namedVolumeMounts returns the Docker-managed named-volume mounts from a
// service's short-syntax volume list. Bind mounts (host paths), anonymous
// volumes (no source — these are not shareable with a sidecar), and read-only
// mounts are excluded: only writable named volumes both need and can receive an
// ownership fixup via a shared sidecar.
func namedVolumeMounts(volumes []string) []volumeMount {
	var mounts []volumeMount
	for _, v := range volumes {
		parts := strings.Split(v, ":")
		if len(parts) < 2 {
			// Single token → anonymous volume; cannot be shared with a sidecar.
			continue
		}
		source, target := parts[0], parts[1]
		if source == "" || target == "" {
			continue
		}
		// Bind mounts have a path-like source; named volumes are bare names.
		if strings.Contains(source, "/") || strings.HasPrefix(source, ".") {
			continue
		}
		if len(parts) >= 3 && isReadOnlyMode(parts[2]) {
			continue
		}
		mounts = append(mounts, volumeMount{source: source, target: target})
	}
	return mounts
}

// isReadOnlyMode reports whether a compose volume mode string (e.g. "ro",
// "ro,z") requests a read-only mount.
func isReadOnlyMode(mode string) bool {
	for _, opt := range strings.Split(mode, ",") {
		if opt == "ro" {
			return true
		}
	}
	return false
}

// chownTarget derives the `chown` ownership argument for a service's resolved
// user. It only applies to non-root numeric users (the form the agent injects
// via DefaultUser); a name-based user can't be resolved to a numeric id from a
// generic init image, so those services are skipped (ok=false). A bare uid
// returns just the uid (group is left as-is — owner permissions already let the
// process write a 0755 directory it owns).
func chownTarget(user string) (string, bool) {
	if user == "" {
		return "", false
	}
	parts := strings.SplitN(user, ":", 2)
	uid, err := strconv.Atoi(parts[0])
	if err != nil || uid == 0 {
		return "", false
	}
	if len(parts) == 2 {
		if gid, err := strconv.Atoi(parts[1]); err == nil {
			return fmt.Sprintf("%d:%d", uid, gid), true
		}
	}
	return strconv.Itoa(uid), true
}

// buildChownSidecar constructs the ephemeral root init sidecar that fixes named
// volume ownership for a hardened non-root service. It mounts the same named
// volumes read-write, runs `chown -R <ownership> <targets>` as root with only
// the CHOWN capability, and exits. It deliberately does NOT carry the global
// non-root user / read-only rootfs hardening, which would defeat the chown.
func buildChownSidecar(image, ownership string, volumeMounts, targets []string) *ComposeService {
	command := append([]string{"chown", "-R", ownership}, targets...)
	return &ComposeService{
		Image:   image,
		User:    "0:0",
		Command: command,
		Volumes: volumeMounts,
		CapDrop: []string{"ALL"},
		CapAdd:  []string{"CHOWN"},
		Restart: "no",
		Labels:  map[string]string{chownSidecarLabel: chownSidecarLabelValue},
		Logging: map[string]any{
			"driver": "json-file",
			"options": map[string]string{
				"max-size": "10m",
				"max-file": "3",
			},
		},
	}
}

// isGeneratedChownSidecar reports whether a service is an agent-generated
// chown-init sidecar, identified by its marker label. Detection is label-based
// (not name-based) so a user service that happens to share the name shape is
// never mistaken for a generated helper.
func isGeneratedChownSidecar(svc *ComposeService) bool {
	return svc != nil && svc.Labels[chownSidecarLabel] == chownSidecarLabelValue
}

// addCompletedDependency adds a `service_completed_successfully` dependency on
// dep to an existing depends_on value, normalizing the short-list form to the
// long (map) form so the condition can be expressed. Existing short-form
// dependencies keep their implicit `service_started` semantics.
func addCompletedDependency(existing any, dep string) any {
	deps := normalizeDependsOn(existing)
	deps[dep] = map[string]any{"condition": "service_completed_successfully"}
	return deps
}

// normalizeDependsOn converts any supported depends_on representation into the
// long map form. Unknown shapes yield an empty map.
func normalizeDependsOn(existing any) map[string]any {
	deps := make(map[string]any)
	switch e := existing.(type) {
	case map[string]any:
		for k, v := range e {
			deps[k] = v
		}
	case []any:
		for _, item := range e {
			if s, ok := item.(string); ok {
				deps[s] = map[string]any{"condition": "service_started"}
			}
		}
	case []string:
		for _, s := range e {
			deps[s] = map[string]any{"condition": "service_started"}
		}
	}
	return deps
}

// stripDependenciesOn removes any depends_on edges that point at one of the
// removed service names (the agent-generated sidecars stripped on re-harden),
// so re-hardening doesn't leave dangling references. Edges are matched by exact
// name membership in removed, never by name shape, so user-authored
// dependencies are never affected.
func stripDependenciesOn(existing any, removed map[string]bool) any {
	if existing == nil || len(removed) == 0 {
		return existing
	}
	deps := normalizeDependsOn(existing)
	changed := false
	for k := range deps {
		if removed[k] {
			delete(deps, k)
			changed = true
		}
	}
	// Leave a depends_on that referenced no removed sidecar exactly as authored
	// (e.g. short-list form) rather than rewriting it to the normalized map form.
	if !changed {
		return existing
	}
	if len(deps) == 0 {
		return nil
	}
	return deps
}

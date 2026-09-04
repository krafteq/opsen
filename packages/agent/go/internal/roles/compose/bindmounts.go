package compose

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/opsen/agent/internal/config"
)

// Bind-mount source confinement.
//
// Docker resolves a bind-mount source as root, so the agent-private 0750
// per-client / per-project directories (files.go) never stand between a
// container and whatever it mounts. With project files world-readable by
// contract, a bind mount of another project's tree would be all a container
// needs to read that project's mapped files — and neither the default deny list
// (which does not cover the deployments directory) nor allowed_host_paths
// (allow-all when unset) stops one. So every bind-mount source is resolved the
// way Compose will resolve it when the project is brought up from its project
// directory, and the resolved path is confined, in this order:
//
//  1. inside the deploying project's own directory: allowed, provided the
//     mount is read-only. That is the MappedFile mechanism
//     (./files/<process>/<path>); the tree is agent-written under the mode
//     contract and is not subject to host path policy. Read-only is what keeps
//     a lexical check sound — a container that could write into the tree could
//     plant a symlink for a later deploy to mount through. The project
//     directory itself is rejected: it is 0750 and unreadable by the service.
//  2. deny.host_paths: rejected.
//  3. overlapping the agent deployments directory — another project's tree
//     (same client or not), the deployments directory or any ancestor of it,
//     the agent's state files: rejected regardless of policy.
//  4. allowed_host_paths (when set): the resolved path must be below an entry.
//
// Sources whose resolution the agent cannot reproduce are rejected outright:
// `~` is expanded by Compose from the agent's own home directory, and $VAR /
// ${VAR} is interpolated by Compose — from the agent's environment and from the
// project's .env file, which the client writes — after validation has run.
//
// Documented in spec.md under "Bind-Mount Source Confinement".

var (
	errInterpolatedSource = errors.New("interpolated ($VAR) bind-mount sources are not supported")
	errHomeRelativeSource = errors.New("home-relative (~) bind-mount sources are not supported")
)

// bindMount is one host-path mount request found in a compose file.
type bindMount struct {
	subject  string // compose entry it belongs to, for violation messages ("service web", "volume data")
	source   string // host path exactly as written
	readOnly bool
}

// isBindMountSource reports whether a short-syntax volume source denotes a host
// path rather than a Docker-managed named volume. Compose classifies a source
// as a path when it starts with `/`, `.` or `~`. A `/` anywhere (not a valid
// volume name) or a `$` (which may interpolate to any of those) is treated as
// a path here as well, so that such a source reaches the bind-mount checks —
// and is rejected there — instead of passing as a named volume.
func isBindMountSource(source string) bool {
	return strings.HasPrefix(source, ".") ||
		strings.HasPrefix(source, "~") ||
		strings.Contains(source, "/") ||
		strings.Contains(source, "$")
}

// parseBindMount parses a short-syntax service volume entry
// (`source:target[:mode]`) into a bindMount, or reports ok=false for a named
// or anonymous volume, which is Docker-managed and carries no host path.
func parseBindMount(subject, volume string) (bindMount, bool) {
	parts := strings.Split(volume, ":")
	if len(parts) < 2 || !isBindMountSource(parts[0]) {
		return bindMount{}, false
	}
	return bindMount{
		subject:  subject,
		source:   parts[0],
		readOnly: len(parts) >= 3 && isReadOnlyMode(parts[2]),
	}, true
}

// resolveBindSource returns the cleaned host path Compose will mount for source
// when the project is brought up from projectDir: an absolute source as-is, a
// relative one joined onto projectDir.
func resolveBindSource(projectDir, source string) (string, error) {
	if strings.Contains(source, "$") {
		return "", errInterpolatedSource
	}
	if strings.HasPrefix(source, "~") {
		return "", errHomeRelativeSource
	}
	if filepath.IsAbs(source) {
		return filepath.Clean(source), nil
	}
	return filepath.Join(projectDir, source), nil
}

// validateBindMount applies the confinement rules above to one bind mount and
// returns the policy violation, or "" when the mount is allowed.
func validateBindMount(m bindMount, projectDir string, cfg *config.AgentConfig, policy *config.ComposePolicy) string {
	resolved, err := resolveBindSource(projectDir, m.source)
	if err != nil {
		return fmt.Sprintf("%s: host path '%s': %v", m.subject, m.source, err)
	}
	where := describeSource(m.source, resolved)

	if resolved == filepath.Clean(projectDir) {
		return fmt.Sprintf("%s: host path %s is the project directory itself, which is agent-private; mount a path below it", m.subject, where)
	}
	if pathWithin(projectDir, resolved) {
		if !m.readOnly {
			return fmt.Sprintf("%s: host path %s is inside the project directory and must be mounted read-only (:ro)", m.subject, where)
		}
		return ""
	}
	if isBlockedPath(resolved, cfg.Deny.HostPaths) {
		return fmt.Sprintf("%s: host path %s not allowed", m.subject, where)
	}
	if deploymentsDir := composeDeploymentsDir(cfg); deploymentsDir != "" &&
		(pathWithin(deploymentsDir, resolved) || pathWithin(resolved, deploymentsDir)) {
		return fmt.Sprintf("%s: host path %s overlaps the agent deployments directory outside this project", m.subject, where)
	}
	if !isAllowedPath(resolved, policy.Volumes.AllowedHostPaths) {
		return fmt.Sprintf("%s: host path %s not in allowed paths", m.subject, where)
	}
	return ""
}

// describeSource renders a source for a violation message, adding the resolved
// path when it differs (relative or unclean sources).
func describeSource(source, resolved string) string {
	if source == resolved {
		return fmt.Sprintf("'%s'", source)
	}
	return fmt.Sprintf("'%s' (resolves to '%s')", source, resolved)
}

// composeDeploymentsDir returns the cleaned compose deployments directory, or
// "" when the compose role is not configured.
func composeDeploymentsDir(cfg *config.AgentConfig) string {
	if cfg.Roles.Compose == nil || cfg.Roles.Compose.DeploymentsDir == "" {
		return ""
	}
	return filepath.Clean(cfg.Roles.Compose.DeploymentsDir)
}

// validateVolumeDefinitions checks the top-level named-volume definitions whose
// driver_opts turn the volume into a bind mount of a host path — the local
// driver's `type: none` / `o: bind` / `device: <path>` form — against the same
// rules as a service's bind-mount source. Without this, a volume *name* the
// per-service checks treat as Docker-managed could reach any host path.
func validateVolumeDefinitions(compose *ComposeFile, projectDir string, cfg *config.AgentConfig, policy *config.ComposePolicy) []string {
	var violations []string
	for name, def := range compose.Volumes {
		m, ok := bindVolumeDefinition("volume "+name, def)
		if !ok {
			continue
		}
		if v := validateBindMount(m, projectDir, cfg, policy); v != "" {
			violations = append(violations, v)
		}
	}
	return violations
}

// bindVolumeDefinition returns the bind mount a top-level volume definition
// requests through its driver_opts, or ok=false when it is not a bind mount.
func bindVolumeDefinition(subject string, def any) (bindMount, bool) {
	m, ok := def.(map[string]any)
	if !ok {
		return bindMount{}, false
	}
	opts, ok := m["driver_opts"].(map[string]any)
	if !ok {
		return bindMount{}, false
	}
	mountType, _ := opts["type"].(string)
	options, _ := opts["o"].(string)
	device, _ := opts["device"].(string)

	bind := mountType == "none"
	readOnly := false
	for _, opt := range strings.Split(options, ",") {
		switch opt {
		case "bind", "rbind":
			bind = true
		case "ro":
			readOnly = true
		}
	}
	if !bind || device == "" {
		return bindMount{}, false
	}
	return bindMount{subject: subject, source: device, readOnly: readOnly}, true
}

// pathWithin reports whether path is base itself or lies below it. Both are
// expected to be cleaned paths of the same kind (absolute in production); the
// comparison is lexical, symlinks are not resolved.
func pathWithin(base, path string) bool {
	rel, err := filepath.Rel(base, path)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// isBlockedPath reports whether a resolved host path is one of the denied
// paths or lies below one. A denied "/" matches only the root itself — it
// exists to stop a container mounting the whole host filesystem, not to deny
// every path on it.
func isBlockedPath(path string, blocked []string) bool {
	for _, b := range blocked {
		b = filepath.Clean(b)
		if b == "/" {
			if path == "/" {
				return true
			}
			continue
		}
		if pathWithin(b, path) {
			return true
		}
	}
	return false
}

// isAllowedPath reports whether a resolved host path is one of the allowed
// paths or lies below one. An empty allow list allows everything.
func isAllowedPath(path string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if pathWithin(filepath.Clean(a), path) {
			return true
		}
	}
	return false
}

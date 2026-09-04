package compose

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Project file mode contract.
//
// The agent runs as the dedicated, non-root `opsen-agent` system user, while a
// hardened service runs as an unrelated non-root uid (GlobalHardening.DefaultUser,
// e.g. 1000:1000) with cap_drop ALL and therefore no CAP_DAC_OVERRIDE. Nothing but
// the "other" permission bits decides whether such a container can read a project
// file the agent bind-mounts into it — and the agent, being non-root, cannot chown
// the files to the service uid. So every file that may be bind-mounted is
// world-readable and every directory that may be bind-mounted is world-searchable,
// while the per-client / per-project directories above them stay agent-private.
// Docker resolves bind-mount sources as root, so those 0750 ancestors never affect
// a container, but they keep other host-local users out of the whole tree (the
// compose file carries resolved environment secrets).
//
// Every write pins its mode with an explicit chmod: os.WriteFile leaves a
// pre-existing file's mode untouched and os.MkdirAll never changes an existing
// directory's mode, and both apply the process umask to new entries. Without the
// chmod, projects deployed by an agent version that wrote 0640/0750 would stay
// unreadable forever.
//
// Documented in spec.md under "Project File Ownership and Modes".
const (
	// projectTreeDirMode applies to the per-client and per-project directories.
	projectTreeDirMode os.FileMode = 0o750
	// composeFileMode applies to the compose file: it is never bind-mounted and
	// carries resolved environment values, so it stays agent-private.
	composeFileMode os.FileMode = 0o640
	// projectFileMode applies to every other project file — each may be
	// bind-mounted read-only into a container running as an arbitrary uid.
	projectFileMode os.FileMode = 0o644
	// projectSubdirMode applies to every directory below the project directory —
	// a directory may itself be a bind-mount source, and the container then needs
	// search permission on it.
	projectSubdirMode os.FileMode = 0o755
)

// projectFileModeFor returns the mode a project file with the given base name is
// written with. It mirrors the compose-file detection Deploy uses for content.
func projectFileModeFor(name string) os.FileMode {
	if isComposeFile(name) {
		return composeFileMode
	}
	return projectFileMode
}

// ensureDir creates dir (and any missing parents, with the same mode) and pins
// dir's own mode, regardless of the umask and of whether dir already existed.
func ensureDir(dir string, mode os.FileMode) error {
	if err := os.MkdirAll(dir, mode); err != nil {
		return err
	}
	return os.Chmod(dir, mode)
}

// ensureProjectSubdirs creates dir and pins every directory between projectDir
// (exclusive) and dir (inclusive) to projectSubdirMode. Each segment is pinned
// individually because MkdirAll silently keeps a pre-existing intermediate
// directory (e.g. a `files/` created 0750 by an older agent) at its old mode.
func ensureProjectSubdirs(projectDir, dir string) error {
	rel, err := filepath.Rel(projectDir, dir)
	if err != nil {
		return err
	}
	if rel == "." {
		return nil
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("directory %s is outside project directory %s", dir, projectDir)
	}
	if err := os.MkdirAll(dir, projectSubdirMode); err != nil {
		return err
	}
	current := projectDir
	for _, segment := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, segment)
		if err := os.Chmod(current, projectSubdirMode); err != nil {
			return err
		}
	}
	return nil
}

// writeProjectFile writes content to path and pins the file's mode. The chmod is
// applied to the open descriptor, i.e. to exactly the file that was written.
func writeProjectFile(path string, content []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(content); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// applyProjectFileModes walks an existing project directory and re-applies the
// mode contract to everything in it: the project directory itself, its
// subdirectories, the compose file and every other regular file. It is how
// projects deployed by an older agent version self-heal on the reconciler's
// redeploy, without a client-side redeploy.
//
// Symlinks and special files are left alone: chmod follows symlinks, and a
// container with a writable bind mount below the project directory could plant
// one pointing at an agent-owned file outside the tree. Errors are collected
// rather than aborting the walk, so a single entry the non-root agent cannot
// chmod (e.g. a container-created file under a writable bind mount) does not
// leave the rest of the tree unrepaired.
func applyProjectFileModes(projectDir string) error {
	projectDir = filepath.Clean(projectDir)
	var errs []error
	walkErr := filepath.WalkDir(projectDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		var mode os.FileMode
		switch {
		case path == projectDir:
			mode = projectTreeDirMode
		case d.IsDir():
			mode = projectSubdirMode
		case d.Type().IsRegular():
			mode = projectFileModeFor(d.Name())
		default:
			return nil
		}
		if err := os.Chmod(path, mode); err != nil {
			errs = append(errs, err)
		}
		return nil
	})
	if walkErr != nil {
		errs = append(errs, walkErr)
	}
	return errors.Join(errs...)
}

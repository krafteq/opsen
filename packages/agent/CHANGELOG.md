# @opsen/agent

## 0.7.1

### Patch Changes

- ea85f14: Fix `AgentInstaller` silently uploading an empty agent binary, leaving a crash-looping agent (`status=203/EXEC`) while `pulumi up` reports success.

  The binary is built locally into `<pkg>/go/out` (inside `node_modules`) and uploaded with `CopyToRemote`. A routine `rm -rf node_modules && npm install` deletes the artifact; the installer then writes a 0-byte placeholder (needed to satisfy `FileAsset`'s registration-time hashing), and if that empty file gets promoted nothing validated it — `chmod +x` and `systemctl start` both "succeed" and the agent dies on `Exec format error`, surfacing only later as `ECONNREFUSED :8443` from a downstream deployer.

  The installer now validates the artifact at two points: the build step asserts the freshly built binary is non-empty (`test -s`) before trusting its hash, and the promotion step refuses to install a 0-byte upload **before** clobbering a known-good binary, then runs `opsen-agent --version` to confirm the promoted binary actually executes on the host. A bad artifact now fails the apply loudly instead of shipping a dead agent.

- 8d96f75: Fix `AgentInstaller` client-policy `MirrorState` failing with `Permission denied` (`status 2`) on non-root SSH targets.

  Every file the installer writes goes through `command.remote.Command` wrapped in `sudo`, except client policies — those are synced by `MirrorState`, which uploads over plain SFTP **as the SSH user with no privilege escalation**. The installer created `/etc/opsen-agent` as root and never prepared `/var/lib/mirror-state`, so on a host reached as a non-root sudo user (e.g. `connection.user = 'deploy'`) the SFTP `mkdir` into the staging dir and the `clients` symlink replacement in the root-owned parent both failed.

  The setup step now mirrors `ComposeProject`'s prep: it creates `/var/lib/mirror-state` and chowns it plus the `/etc/opsen-agent` parent (non-recursively) to the connection user, so `MirrorState`'s unprivileged writes succeed. Files inside `/etc/opsen-agent` (`agent.yaml`, `*.pem`) keep their `opsen-agent` ownership, and the change is a no-op when connecting as root.

  This was latent because `MirrorState` only writes when rendered content changes; it surfaced the first time a client policy's bytes actually changed on a `deploy`-user target.

## 0.7.0

### Minor Changes

- 325583d: Auto-fix named-volume ownership for hardened non-root Compose services. The agent forces a non-root `user:` and a read-only rootfs onto every service, but Docker initializes a fresh named volume as `root:root 0755`, so the injected user got `EACCES` on its own declared volume/cache — the only workaround was running the long-lived, network-exposed container as root (`elevated`/`privileged`).

  `hardenCompose` now injects an ephemeral `{service}-opsen-chown-init` sidecar for each hardened non-root service that mounts writable named volumes. The sidecar runs as `user: "0:0"` with `cap_drop: [ALL]` + `cap_add: [CHOWN, DAC_READ_SEARCH]`, `chown -R`s the mounts to the service's uid:gid, and exits before the app starts (wired via `depends_on: { condition: service_completed_successfully }`). It is built after the per-service hardening pass so the global `cap_drop: ALL` and read-only rootfs don't strip the ownership-fixup capabilities / block the chown. Bind mounts, anonymous volumes, read-only mounts, and name-based (non-numeric) users are skipped; re-hardening is idempotent.

  The sidecar image is configurable via `global_hardening.chown_init_image` (defaults to `busybox`), exposed through the Pulumi installer as `globalHardening.chownInitImage` for pointing at an internal-registry mirror on air-gapped/registry-restricted hosts. Existing deployments migrate automatically via a policy-hash bump. Running non-root and mounting a writable volume are no longer mutually exclusive on the Compose backend, removing the need for `elevated`/`privileged` as an ownership workaround. (Throwaway caches such as a Chromium crashpad dir should instead be emitted as `tmpfs:` by upstream codegen.)

- 937c452: Make compose container PID limits configurable. `per_container.default_pids` now controls the applied default limit, service-level `pids_limit` is preserved when valid, and `per_container.max_pids` is now a cap instead of the forced applied value.

  Operators that used `max_pids` to raise the applied limit should move that value to `default_pids`. If `max_pids` is below the default PID limit of 256, also set `per_container.default_pids` at or below the cap.

## 0.6.0

### Minor Changes

- 362d440: Isolate compose project networks per project. Previously all compose projects belonging to one client shared a single `opsen-{client}-internal` network, so services in different projects could reach each other by docker DNS. Each project now gets its own `opsen-{client}-{project}-internal` network. Cross-project communication must go through ingress.

  Existing deployments are migrated automatically: the policy hash is bumped so the reconciler redeploys each project once onto its own network, and the legacy shared network is removed best-effort after each redeploy.

## 0.5.0

### Minor Changes

- 667bb63: Remove opsen\_ prefix and client scoping from database and role names. Clients now have full control over naming — database and role names are globally unique, first-come-first-served.
- 36a8e8d: Track created_at and modified_at timestamps in state for databases and compose projects. Timestamps are surfaced in status API responses.
- 14ee289: Replace `Output<unknown>` with strongly typed response interfaces on all dynamic resource outputs (ComposeProject, Database, DatabaseRole, IngressRoutes).

## 0.4.2

### Patch Changes

- 3447577: Bump Dockerfile.build from golang 1.23 to 1.24 to match go.mod toolchain upgrade.

## 0.4.1

### Patch Changes

- b12ce02: Make ingress delete operations idempotent — no longer returns 500 when config files don't exist or were already deleted. Also cleans up legacy pre-app-scoping config files (`{client}.conf`) during delete and includes them in MaxRoutes validation.

## 0.4.0

### Minor Changes

- 541e039: Add app-scoped ingress routes. Each Pulumi project can now independently manage its own routes within a shared client connection by specifying an `app` name. New API endpoints: `PUT/GET /v1/ingress/apps/{app}/routes` and `DELETE /v1/ingress/apps/{app}`. Legacy endpoints remain backwards-compatible using `_default` app. MaxRoutes policy is enforced across all apps for the client.
- 0d8136d: Wrap all resource Args fields with `pulumi.Input<>` for consumer flexibility. Arrays and Records are double-wrapped (e.g. `pulumi.Input<pulumi.Input<string>[]>`). Consumers can now pass Outputs directly without `.apply()` wrappers.

### Patch Changes

- 40cd22f: Fix dependency vulnerabilities: upgrade node-forge to 1.4.0 (4 high CVEs in cert chain verification, Ed25519/RSA signature forgery, DoS) and Go toolchain to 1.24.13 (14 stdlib CVEs in crypto/tls, crypto/x509, net/url, encoding/asn1, os/exec, database/sql).
- Updated dependencies [0d8136d]
  - @opsen/docker-compose@0.3.0

## 0.3.0

### Minor Changes

- fd05649: feat(agent): add host port allocation, tmpfs merge, and MirrorState client policies
  - Compose role manages host port allocation from a configured `port_range`. Services declare container ports via `expose:`, and the agent allocates host ports bound to the client's `ingress_bind_address`. Port mappings are returned in the deploy response.
  - Tmpfs handling merges client entries with global defaults instead of overwriting.
  - Client policy files are now managed via MirrorState (from @opsen/docker-compose) instead of individual remote commands, ensuring stale policy files are cleaned up when clients are removed.

## 0.2.2

### Patch Changes

- 33d4889: Fix AgentInstaller failing in Pulumi preview (plan) mode when binary has not been built yet by creating an empty placeholder file for FileAsset hash computation.

  Fix docker-compose MirrorState dynamic provider to use lazy `require()` imports, avoiding Pulumi closure serialization failures with pnpm store paths.

## 0.2.1

### Patch Changes

- 6e55360: Stop running agent service before uploading new binary to prevent SFTP ETXTBSY failure

## 0.2.0

### Minor Changes

- 1e95d91: Add bind address support to ingress routes for binding to specific IPs (e.g. internal-only routes)

## 0.1.2

### Patch Changes

- 5df2593: Remove compiled Go binary from published package. The agent is built on the target server from source.

## 0.1.1

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.
- bc630fd: Fix published packages being unusable from npm. Replace `file:` inter-workspace references with pnpm `workspace:^` protocol so dependencies resolve to proper version ranges when published. Add `prepack` script to cert-renewer to ensure `azure-function.zip` is included in the tarball. Add `go/out` to agent `files` array to override `.gitignore` and include the compiled Go binary.

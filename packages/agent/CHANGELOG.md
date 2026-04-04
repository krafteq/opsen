# @opsen/agent

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

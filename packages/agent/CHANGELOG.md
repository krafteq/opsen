# @opsen/agent

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

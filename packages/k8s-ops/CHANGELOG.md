# @opsen/k8s-ops

## 0.1.3

### Patch Changes

- 33d4889: Fix AgentInstaller failing in Pulumi preview (plan) mode when binary has not been built yet by creating an empty placeholder file for FileAsset hash computation.

  Fix package.json `main` field across all packages to point to `dist/index.js` instead of `src/index.ts`, removing redundant `publishConfig` overrides.

  Fix docker-compose MirrorState dynamic provider to use lazy `require()` imports, avoiding Pulumi closure serialization failures with pnpm store paths.

- Updated dependencies [33d4889]
  - @opsen/platform@0.3.2
  - @opsen/k8s@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies [98d8ae3]
  - @opsen/platform@0.3.0
  - @opsen/k8s@0.2.0

## 0.1.1

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.
- bc630fd: Fix published packages being unusable from npm. Replace `file:` inter-workspace references with pnpm `workspace:^` protocol so dependencies resolve to proper version ranges when published. Add `prepack` script to cert-renewer to ensure `azure-function.zip` is included in the tarball. Add `go/out` to agent `files` array to override `.gitignore` and include the compiled Go binary.
- Updated dependencies [2fa5204]
- Updated dependencies [bc630fd]
  - @opsen/platform@0.2.1
  - @opsen/k8s@0.1.2

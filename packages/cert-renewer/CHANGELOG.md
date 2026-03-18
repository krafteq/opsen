# @opsen/cert-renewer

## 0.2.1

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.
- bc630fd: Fix published packages being unusable from npm. Replace `file:` inter-workspace references with pnpm `workspace:^` protocol so dependencies resolve to proper version ranges when published. Add `prepack` script to cert-renewer to ensure `azure-function.zip` is included in the tarball. Add `go/out` to agent `files` array to override `.gitignore` and include the compiled Go binary.

## 0.2.0

### Minor Changes

- a8cb2c7: New package for automated ACME certificate renewal. Discovers opsen-managed certificates in Azure Key Vault via tags, issues/renews via Let's Encrypt DNS-01, and updates KV secrets with PFX. Ships a pre-built Azure Function zip artifact (282KB esbuild bundle) for zero-config deployment.

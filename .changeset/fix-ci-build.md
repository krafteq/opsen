---
'@opsen/platform': patch
'@opsen/base-ops': patch
'@opsen/k8s': patch
'@opsen/docker': patch
'@opsen/azure': patch
'@opsen/k8s-ops': patch
'@opsen/cert-renewer': patch
'@opsen/vault-fact-store': patch
'@opsen/azure-fact-store': patch
'@opsen/docker-compose': patch
'@opsen/powerdns': patch
'@opsen/agent': patch
---

Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.

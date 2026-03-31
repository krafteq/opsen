---
'@opsen/agent': patch
'@opsen/platform': patch
'@opsen/base-ops': patch
'@opsen/k8s': patch
'@opsen/k8s-ops': patch
'@opsen/docker': patch
'@opsen/docker-compose': patch
'@opsen/azure': patch
'@opsen/powerdns': patch
'@opsen/vault-fact-store': patch
'@opsen/azure-fact-store': patch
---

Fix AgentInstaller failing in Pulumi preview (plan) mode when binary has not been built yet by creating an empty placeholder file for FileAsset hash computation.

Fix package.json `main` field across all packages to point to `dist/index.js` instead of `src/index.ts`, removing redundant `publishConfig` overrides.

Fix docker-compose MirrorState dynamic provider to use lazy `require()` imports, avoiding Pulumi closure serialization failures with pnpm store paths.

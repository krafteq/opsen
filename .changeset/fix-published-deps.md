---
'@opsen/azure': patch
'@opsen/azure-fact-store': patch
'@opsen/vault-fact-store': patch
'@opsen/docker': patch
'@opsen/k8s': patch
'@opsen/k8s-ops': patch
'@opsen/cert-renewer': patch
'@opsen/agent': patch
---

Fix published packages being unusable from npm. Replace `file:` inter-workspace references with pnpm `workspace:^` protocol so dependencies resolve to proper version ranges when published. Add `prepack` script to cert-renewer to ensure `azure-function.zip` is included in the tarball. Add `go/out` to agent `files` array to override `.gitignore` and include the compiled Go binary.

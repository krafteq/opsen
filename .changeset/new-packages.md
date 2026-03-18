---
'@opsen/vault-fact-store': minor
'@opsen/azure-fact-store': minor
'@opsen/powerdns': minor
'@opsen/docker-compose': minor
'@opsen/base-ops': minor
---

Add vault-fact-store, azure-fact-store, powerdns, and docker-compose packages. Enhance base-ops with fact label support and deployer tests. Azure-fact-store uses owner as secret name prefix for stale cleanup (no manifest), plain `{owner}--{kind}--{name}` naming (no base64url), and JSON-parses all values to detect facts.

# @opsen/powerdns

## 0.2.0

### Minor Changes

- a8cb2c7: Add vault-fact-store, azure-fact-store, powerdns, and docker-compose packages. Enhance base-ops with fact label support and deployer tests. Azure-fact-store uses owner as secret name prefix for stale cleanup (no manifest), plain `{owner}--{kind}--{name}` naming (no base64url), and JSON-parses all values to detect facts.

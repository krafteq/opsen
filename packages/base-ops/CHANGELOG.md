# @opsen/base-ops

## 0.3.0

### Minor Changes

- a2a0f94: Add grouped secret facts and secret resolver to FactsPool
  - `secretGroup()` factory for defining multiple named secret values under a single group name
  - `pool.getSecret()`/`pool.requireSecret()` resolve camelCase names by exact match or group+property split (e.g. `netbirdApiKey` → group `netbird`, property `apiKey`)
  - Vault fact store now reads/writes grouped secret specs and coerces number values to strings

## 0.2.2

### Patch Changes

- 8a889b3: Fix exposed facts losing their owner after Pulumi output resolution by applying default owner at resolution time.

## 0.2.1

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.

## 0.2.0

### Minor Changes

- a8cb2c7: Add vault-fact-store, azure-fact-store, powerdns, and docker-compose packages. Enhance base-ops with fact label support and deployer tests. Azure-fact-store uses owner as secret name prefix for stale cleanup (no manifest), plain `{owner}--{kind}--{name}` naming (no base64url), and JSON-parses all values to detect facts.

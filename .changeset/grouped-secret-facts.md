---
'@opsen/base-ops': minor
'@opsen/vault-fact-store': minor
---

Add grouped secret facts and secret resolver to FactsPool

- `secretGroup()` factory for defining multiple named secret values under a single group name
- `pool.getSecret()`/`pool.requireSecret()` resolve camelCase names by exact match or group+property split (e.g. `netbirdApiKey` → group `netbird`, property `apiKey`)
- Vault fact store now reads/writes grouped secret specs and coerces number values to strings

---
'@opsen/vault-fact-store': minor
---

feat(vault-fact-store): resilient read and owner filtering

- Skip malformed or inaccessible secrets during read instead of failing (Vault paths may contain non-opsen secrets)
- Add optional `owners` list to limit which owners' facts are read
- Validate simple secret `value` is a string before including it

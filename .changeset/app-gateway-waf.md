---
'@opsen/azure': minor
---

Add Application Gateway WAF integration with dynamic sub-resource providers. Endpoints with `_az.waf: true` are automatically routed through App Gateway with ACME TLS certificates via Key Vault. Includes createAppGateway building block, six dynamic providers (listener, pool, settings, rule, probe, ssl-cert) with etag-based optimistic concurrency, and cert renewal building blocks (Azure Function and Container App Job).

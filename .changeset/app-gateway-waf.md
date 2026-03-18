---
'@opsen/azure': minor
---

Add Application Gateway WAF integration with dynamic sub-resource providers. Endpoints with `_az.waf: true` are automatically routed through App Gateway with ACME TLS certificates via Key Vault. Includes AppGatewayDeployer, six dynamic providers (listener, pool, settings, rule, probe, ssl-cert) with etag-based optimistic concurrency, CertRenewalFunctionDeployer and CertRenewalJobDeployer for automated certificate renewal. All deployers extend AzureDeployer for shared provider management. App Gateway sub-resources use sequential dependsOn chains to prevent concurrent PUT failures. ACME certificate provider handles Key Vault soft-delete recovery. WAF endpoints skip direct custom domain binding (traffic routes through App Gateway). WebAppDeployer gains Application Insights support.

# @opsen/cert-renewer

## 0.2.0

### Minor Changes

- a8cb2c7: New package for automated ACME certificate renewal. Discovers opsen-managed certificates in Azure Key Vault via tags, issues/renews via Let's Encrypt DNS-01, and updates KV secrets with PFX. Ships a pre-built Azure Function zip artifact (282KB esbuild bundle) for zero-config deployment.

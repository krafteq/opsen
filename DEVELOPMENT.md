# Development Status

## Current State (Mar 2026)

All packages are implemented and building. No published npm releases yet — first release pending via changesets workflow.

### What's done

- Monorepo setup (pnpm workspaces, composite tsconfig, changesets, CI/CD via GitHub Actions)
- `@opsen/platform` — standalone workload type system, RuntimeDeployer interface, utility types. Runtime-specific types (`AzureRuntime`, `DockerRuntime`, `KubernetesRuntime`) live in their respective packages.
- `@opsen/base-ops` — facts system with labels, FactStore abstraction (`FactStoreReader` / `FactStoreWriter`), deployer pipeline, config management
- `@opsen/k8s` — Kubernetes deployer (Deployments, Services, Ingress, PVCs, ConfigMaps) + building blocks
- `@opsen/docker` — Docker deployer with Caddy reverse proxy for ingress + building blocks
- `@opsen/azure` — Azure Container Apps deployer, Web App deployer, App Gateway WAF integration with ACME TLS, certificate renewal (Function + Job), all deployers extend `AzureDeployer` base class for shared provider management
- `@opsen/k8s-ops` — Generic K8s cluster components (cert-manager, ingress-nginx, external-dns, Prometheus, Loki, OAuth2, MinIO, Kafka)
- `@opsen/cert-renewer` — ACME certificate renewal CLI and Azure Function for Key Vault + App Gateway
- `@opsen/vault-fact-store` — HashiCorp Vault KV v2 FactStore backend
- `@opsen/azure-fact-store` — Azure Key Vault FactStore backend with owner-based prefix naming and stale cleanup
- `@opsen/docker-compose` — SSH-based Docker Compose deployer with MirrorState file sync
- `@opsen/powerdns` — Pulumi dynamic providers for PowerDNS authoritative server and Recursor
- `@opsen/agent` — VM deploy agent (Go binary + Pulumi installer) for Docker Compose, Caddy ingress, PostgreSQL via mTLS
- Building block functions extracted as public API for each runtime
- Unit tests for building blocks and FactStore implementations
- E2e testing framework for runtime deployers
- CI pipeline (format, lint, type-check, test, build) and release pipeline (changesets → version PR → npm publish)

### What's next

- [ ] First npm publish (merge pending version PR from changesets)
- [ ] K8s example
- [ ] API docs (TypeDoc)
- [ ] Stabilize API surface, bump to 1.0

## Known Issues

1. **K8s `processFullName` bug** — ternary logic is inverted, always returns just `name` instead of `name-processName`
2. **ACA exec probes** — Azure Container Apps doesn't support exec probes; deployer falls back to tcpSocket
3. **Docker scale + ports** — when `scale > 1`, only the first instance binds host ports; others accessible via network only

## Architecture Decisions

See [SPEC.md](./SPEC.md) for project vision and design rationale.

### AzureDeployer base class

All Azure deployers (ContainerAppDeployer, WebAppDeployer, AppGatewayDeployer, CertRenewalFunctionDeployer, CertRenewalJobDeployer) extend `AzureDeployer`. The base class manages a shared Azure Native provider keyed by deployment name (so multiple deployers targeting the same Azure context reuse one provider instance) and provides an `options()` helper that injects the provider into Pulumi resource options.

### App Gateway sub-resource ordering

App Gateway sub-resources (listeners, pools, settings, rules) are created via dynamic providers that use Azure REST API with etag-based optimistic concurrency. Sub-resources for a given endpoint are chained with `dependsOn` to prevent concurrent PUT failures — Azure rejects parallel modifications to the same gateway.

### file: deps instead of workspace:\*

Inter-package dependencies use `file:` relative paths so that external consumers can reference opsen packages via `file:` during development. pnpm resolves these correctly when publishing.

### One ContainerApp per process (Azure)

Each workload process becomes a separate ContainerApp for independent scaling, matching ACA's native architecture.

### Caddy for Docker ingress

Chosen over nginx/traefik for auto-TLS, simple programmatic config, and minimal footprint on single-host deployments.

### Building blocks pattern

Each runtime deployer exports both the monolithic `RuntimeDeployer` and individual building-block functions. The deployer delegates to the building blocks, so users can compose individual pieces without buying into the full pipeline.

### Azure-fact-store naming

Secrets are stored with plain `{owner}--{kind}--{name}` names (no encoding). The owner prefix enables scoped stale cleanup without a manifest — on write, secrets matching the owner prefix but not in the current write set are deleted. Values are always JSON; on read, any secret that parses as a valid fact (has `kind`, `metadata.name`, `spec`) is included.

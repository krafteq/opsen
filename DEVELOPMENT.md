# Development Status

## Current State (Feb 2026)

All five packages are implemented and building. No published npm releases yet.

### What's done

- Monorepo setup (pnpm workspaces, composite tsconfig, changesets)
- `@opsen/infra` — facts system, deployer pipeline, config management
- `@opsen/platform` — workload type system, RuntimeDeployer interface, WorkloadModule
- `@opsen/k8s` — Kubernetes deployer (Deployments, Services, Ingress, PVCs, ConfigMaps)
- `@opsen/docker` — Docker deployer with Caddy reverse proxy for ingress
- `@opsen/azure` — Azure Container Apps deployer
- Examples for Docker and Azure workloads

### What's next

- [ ] CI pipeline (`.github/workflows/ci.yml`)
- [ ] Tests (facts-pool queries, Caddyfile generation, probe mapping)
- [ ] K8s example
- [ ] API docs (TypeDoc)
- [ ] npm publish + changesets release workflow
- [ ] Stabilize API surface, bump to 1.0

## Known Issues

1. **K8s `processFullName` bug** — ternary logic is inverted, always returns just `name` instead of `name-processName`
2. **ACA exec probes** — Azure Container Apps doesn't support exec probes; deployer falls back to tcpSocket
3. **Docker scale + ports** — when `scale > 1`, only the first instance binds host ports; others accessible via network only
4. **No tests** — all packages stub `"test": "echo 'no tests yet'"`

## Architecture Decisions

See [SPEC.md](./SPEC.md) for project vision and design rationale.

### file: deps instead of workspace:\*

Inter-package dependencies use `file:` relative paths so that external consumers can reference opsen packages via `file:` during development. pnpm resolves these correctly when publishing.

### One ContainerApp per process (Azure)

Each workload process becomes a separate ContainerApp for independent scaling, matching ACA's native architecture.

### Caddy for Docker ingress

Chosen over nginx/traefik for auto-TLS, simple programmatic config, and minimal footprint on single-host deployments.

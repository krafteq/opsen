# Opsen

Runtime-agnostic infrastructure platform for [Pulumi](https://www.pulumi.com/). Define workloads once, deploy to Kubernetes, Docker, or Azure.

See [SPEC.md](./SPEC.md) for the full project vision and design rationale.

## Packages

```text
@opsen/platform             ← workload model, RuntimeDeployer interface (standalone)
@opsen/base-ops             ← facts, FactStore, config, deployer pipeline (standalone)
    ↑               ↑               ↑
@opsen/k8s      @opsen/docker      @opsen/azure          ← runtime deployers
    ↑                               ↑
@opsen/k8s-ops                 @opsen/cert-renewer       ← cluster ops / ACME renewal

@opsen/vault-fact-store   @opsen/azure-fact-store        ← FactStore backends (→ base-ops)
@opsen/docker-compose     @opsen/powerdns    @opsen/agent ← standalone utilities
```

Runtime packages are independently installable and never depend on each other.

| Package                   | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `@opsen/platform`         | Workload type system, RuntimeDeployer interface, runtime abstractions             |
| `@opsen/base-ops`         | Infrastructure facts, FactStore abstraction, deployer pipeline, config management |
| `@opsen/k8s`              | Kubernetes runtime — Deployments, Services, Ingress, PVCs, ConfigMaps             |
| `@opsen/docker`           | Docker single-host runtime with Caddy reverse proxy for ingress                   |
| `@opsen/azure`            | Azure Container Apps and Web App runtimes with App Gateway WAF and ACME TLS       |
| `@opsen/k8s-ops`          | Generic K8s cluster components (cert-manager, ingress-nginx, monitoring, Kafka)   |
| `@opsen/cert-renewer`     | ACME certificate renewal for Azure Key Vault + App Gateway                        |
| `@opsen/vault-fact-store` | HashiCorp Vault KV v2 backend for FactStore                                       |
| `@opsen/azure-fact-store` | Azure Key Vault backend for FactStore                                             |
| `@opsen/docker-compose`   | SSH-based Docker Compose deployer with file sync                                  |
| `@opsen/powerdns`         | Pulumi dynamic providers for PowerDNS authoritative server and Recursor           |
| `@opsen/agent`            | VM deploy agent — Docker Compose, Caddy ingress, PostgreSQL via mTLS              |

## Quick Start

```bash
npm install @opsen/platform @opsen/docker
```

```typescript
import { DockerRuntime, Workload } from '@opsen/platform'
import { DockerRuntimeDeployer } from '@opsen/docker'

const runtime = new DockerRuntimeDeployer({
  name: 'myapp',
  acmeEmail: 'admin@example.com',
})

const workload: Workload<DockerRuntime> = {
  image: 'node:22-alpine',
  processes: {
    web: {
      cmd: ['node', 'server.js'],
      ports: { http: { port: 3000, protocol: 'http' } },
    },
  },
  endpoints: {
    'web-public': {
      backend: { process: 'web', port: 'http' },
      ingress: { hosts: ['myapp.example.com'] },
    },
  },
}

const deployed = runtime.deploy(workload, { name: 'myapp' })
```

The same workload shape works across runtimes. Swap `DockerRuntimeDeployer` for `K8sRuntimeDeployer` or `AzureRuntimeDeployer` and the workload deploys to that target instead. Runtime-specific tuning is available via optional `_k8s`, `_docker`, or `_aca` fields.

## Azure Deployers

The `@opsen/azure` package provides two runtime deployers and several infrastructure deployers that all extend a shared `AzureDeployer` base class for provider management:

**Runtime deployers** (implement `RuntimeDeployer`, deploy workloads):

- `AzureRuntimeDeployer` — maps processes to Azure Container Apps
- `AzureWebAppRuntimeDeployer` — maps processes to Azure Web Apps for Containers

**Infrastructure deployers** (extend `AzureDeployer`, deploy supporting resources):

- `ContainerAppDeployer` / `WebAppDeployer` — lower-level deployers used by the runtime deployers
- `AppGatewayDeployer` — Application Gateway with WAF_v2, public IP, auto-scaling
- `CertRenewalFunctionDeployer` — Azure Function for automated ACME certificate renewal
- `CertRenewalJobDeployer` — Container App Job alternative for certificate renewal

WAF endpoints (`_az.waf: true`) are automatically routed through App Gateway with ACME TLS certificates via Key Vault. Six dynamic providers (listener, pool, settings, rule, probe, ssl-cert) manage App Gateway sub-resources with etag-based optimistic concurrency.

## Facts System

`@opsen/base-ops` provides a typed facts system for passing structured state between Pulumi stacks. Facts are `kind + metadata + spec` objects indexed in a `FactsPool` for O(1) lookup by kind+name and label-based filtering. The `FactStore` abstraction decouples storage from Pulumi StackReferences:

| Backend               | Package                                        |
| --------------------- | ---------------------------------------------- |
| Pulumi StackReference | `@opsen/base-ops` (built-in `PulumiFactStore`) |
| HashiCorp Vault KV v2 | `@opsen/vault-fact-store`                      |
| Azure Key Vault       | `@opsen/azure-fact-store`                      |

## Runtime Feature Matrix

| Feature         | K8s                | Docker              | Azure ACA               | Azure Web App      |
| --------------- | ------------------ | ------------------- | ----------------------- | ------------------ |
| Processes       | Deployment         | Container           | ContainerApp            | WebApp             |
| Scaling         | replicas           | instance suffix     | minReplicas/maxReplicas | App Service Plan   |
| Volumes         | PVC                | Docker Volume       | AzureFile / EmptyDir    | Azure Files        |
| Files           | ConfigMap          | Container upload    | Secret volume           | —                  |
| Ingress         | Ingress + nginx    | Caddy reverse proxy | ACA native              | Built-in           |
| TLS             | cert-manager       | Caddy auto-TLS      | ACA managed certs       | App Service certs  |
| WAF             | —                  | —                   | App Gateway WAF_v2      | App Gateway WAF_v2 |
| Health checks   | K8s probes         | Docker HEALTHCHECK  | ACA probes              | Health check path  |
| CORS            | nginx annotation   | Caddy headers       | ACA corsPolicy          | —                  |
| Deploy strategy | Recreate / Rolling | Recreate            | Revision-based          | Slot-based         |
| Resource limits | requests / limits  | memory + cpuShares  | cpu + memory            | App Service Plan   |

## Development

```bash
pnpm install
pnpm build       # tsc --build with project references
pnpm test        # unit tests (Vitest)
pnpm test:e2e    # integration tests
pnpm lint        # ESLint
pnpm ts:check    # TypeScript type checking
```

Requires **Node.js >= 22** and **pnpm >= 10.12.1**. Uses conventional commits (enforced by commitlint + husky) and [changesets](https://github.com/changesets/changesets) for versioning.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for current status and known issues.

## License

Apache-2.0

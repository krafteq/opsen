# Opsen

Runtime-agnostic infrastructure platform for [Pulumi](https://www.pulumi.com/). Define workloads once, deploy to Kubernetes, Docker, or Azure Container Apps.

See [SPEC.md](./SPEC.md) for the full project vision and design rationale.

## Packages

```text
@opsen/platform           ← workload model, RuntimeDeployer interface (standalone)
@opsen/base-ops           ← facts, FactStore, config, deployer pipeline (standalone)
    ↑           ↑            ↑
@opsen/k8s   @opsen/docker   @opsen/azure      ← runtime deployers (depend on platform)
    ↑
@opsen/k8s-ops            ← cluster components (depends on platform, k8s)
```

Runtime packages are independently installable and never depend on each other.

| Package           | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `@opsen/platform` | Workload type system, runtime abstractions, RuntimeDeployer interface    |
| `@opsen/base-ops` | Infrastructure facts, FactStore abstraction, deployer pipeline           |
| `@opsen/k8s`      | Kubernetes runtime — Deployments, Services, Ingress, PVCs                |
| `@opsen/docker`   | Docker single-host runtime with Caddy reverse proxy for ingress          |
| `@opsen/azure`    | Azure Container Apps runtime with native ingress                         |
| `@opsen/k8s-ops`  | Generic K8s cluster components (cert-manager, ingress-nginx, monitoring) |

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

## Runtime Feature Matrix

| Feature         | K8s                      | Docker              | Azure ACA               |
| --------------- | ------------------------ | ------------------- | ----------------------- |
| Processes       | Deployment               | Container           | ContainerApp            |
| Scaling         | replicas                 | instance suffix     | minReplicas/maxReplicas |
| Volumes         | PVC                      | Docker Volume       | AzureFile / EmptyDir    |
| Files           | ConfigMap                | Container upload    | Secret volume           |
| Ingress         | Ingress + nginx          | Caddy reverse proxy | ACA native              |
| TLS             | cert-manager             | Caddy auto-TLS      | ACA managed certs       |
| Health checks   | K8s probes               | Docker HEALTHCHECK  | ACA probes              |
| CORS            | nginx annotation         | Caddy headers       | ACA corsPolicy          |
| Deploy strategy | Recreate / RollingUpdate | Recreate            | Revision-based          |
| Resource limits | requests / limits        | memory + cpuShares  | cpu + memory            |

## Development

```bash
pnpm install
pnpm run build
pnpm run test
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for current status and known issues.

## License

Apache-2.0

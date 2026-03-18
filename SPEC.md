# Opsen — Project Specification

## Problem

Teams deploying containerized applications face a recurring dilemma: the infrastructure they target changes over time, but the applications themselves don't. A web service with a background worker, a database, and a public endpoint is fundamentally the same workload whether it runs on Kubernetes, a single Docker host, or a managed container platform like Azure Container Apps.

Today, Pulumi programs are tightly coupled to the target runtime. Switching from Docker Compose to Kubernetes — or from Kubernetes to a managed platform — means rewriting infrastructure code from scratch. Even within a single runtime, teams duplicate boilerplate across projects: namespace creation, image pull secrets, ingress resources, TLS certificates, health check configuration.

There is no standard way to say "here is my application, deploy it wherever makes sense" in Pulumi.

## What Opsen Is

Opsen is a set of TypeScript libraries for Pulumi that separate _what_ you deploy from _where_ you deploy it.

You describe your application once — its processes, ports, environment variables, health checks, volumes, and public endpoints. Then you choose a runtime deployer (Kubernetes, Docker, Azure Container Apps) and Opsen translates your description into the correct Pulumi resources for that target.

The goal is not to hide the underlying platform. Runtime-specific tuning (K8s resource requests, Docker memory limits, ACA scaling rules) is always available via optional typed extensions. The goal is to make the common case trivial and the platform switch painless.

## Use Case

We built Opsen to solve our own problem. We run a small fleet of services across Kubernetes clusters and occasionally need to spin up the same workloads on a single Docker host for development, or evaluate moving services to a managed platform. We were maintaining three separate sets of Pulumi code for what was conceptually the same deployment.

Opsen grew out of extracting the generic parts of our internal platform tooling into something reusable. The internal code remains a thin consumer that adds organization-specific resource providers (managed databases, object storage, email) on top of Opsen's workload primitives.

The typical Opsen user is a small-to-medium team that:

- Deploys containerized services with Pulumi (not Terraform, not Helm)
- Wants to target multiple runtimes without duplicating infrastructure code
- Needs a lightweight application model — not a full PaaS, just enough structure to avoid copy-pasting Deployment/Service/Ingress YAML equivalents across projects
- Values type safety and wants their IDE to tell them what's available

## Design Principles

**Describe, don't orchestrate.** A workload is a data structure, not a sequence of imperative steps. The runtime deployer decides how to realize it.

**Runtime-specific is opt-in.** The core workload type has no mention of Kubernetes, Docker, or Azure. Each runtime adds optional fields (`_k8s`, `_docker`, `_aca`) that are fully typed but never required.

**One package per runtime.** Install only what you use. `@opsen/k8s` doesn't pull in Docker dependencies. Runtime packages never depend on each other.

**Pulumi-native.** Opsen doesn't wrap Pulumi or introduce its own state management. It produces standard Pulumi resources. You can mix Opsen-deployed workloads with hand-written Pulumi code in the same program.

**Facts for cross-stack state.** Complex setups often span multiple Pulumi stacks (networking in one, platform in another, workloads in a third). `@opsen/base-ops` provides a typed facts system for passing structured state between stacks without ad-hoc output parsing. The FactStore abstraction (`FactStoreReader` / `FactStoreWriter`) decouples fact storage from Pulumi StackReferences, so teams can share facts via any backend (Vault, Azure Key Vault, S3, etc.).

## What Opsen Is Not

- **Not a PaaS.** There is no control plane, no CLI, no dashboard. Opsen is a library you use inside Pulumi programs.
- **Not a Helm replacement.** Opsen doesn't template YAML. It creates Pulumi resources programmatically.
- **Not a multi-cloud abstraction layer.** It doesn't try to make AWS and Azure look the same. It makes _workload deployment_ look the same across container runtimes.
- **Not opinionated about CI/CD.** Opsen doesn't know or care how you run `pulumi up`.

## Packages

### @opsen/base-ops

Low-level primitives for multi-stack Pulumi projects:

- **Facts** — typed data objects (kind + metadata + spec) that flow between stacks. Think of them as lightweight CRDs for your infrastructure state.
- **Facts Pool** — indexed collection with O(1) lookup by kind+name and label-based filtering.
- **FactStore** — storage-agnostic abstraction for reading and writing facts. `FactStoreReader` and `FactStoreWriter` are Pulumi-free interfaces; `PulumiFactStore` provides the StackReference-backed implementation. Custom implementations can target any backend (Vault, Key Vault, S3, a database).
- **Deployer** — sequential module execution pipeline that accumulates facts as side effects. Accepts both legacy `configStacks` (StackReference-based) and `factSources` / `factSink` (FactStore-based) for reading and writing facts.
- **Config** — cross-stack configuration reader and merger.

This package has no opinion about workloads or containers. It's useful on its own for any multi-stack Pulumi project that needs structured state sharing.

### @opsen/platform

The application model:

- **Workload** — processes, endpoints, volumes, files, health checks, environment variables. Parameterized by a runtime type for platform-specific extensions.
- **RuntimeDeployer** — interface that each runtime implements. Takes a Workload, returns DeployedWorkload (with resolved endpoints and process handles).
- **WorkloadModule** — bridges RuntimeDeployer into the `@opsen/base-ops` deployer pipeline, exposing deployment results as facts.
- **Runtime types** — `KubernetesRuntime`, `DockerRuntime`, `AzureContainerAppsRuntime`. Each defines what platform-specific fields are available.

### @opsen/k8s

Kubernetes RuntimeDeployer. For each workload:

- Creates a Deployment per process
- Creates Services and Ingress resources for endpoints
- Manages PersistentVolumeClaims for volumes
- Creates ConfigMaps for injected files
- Handles image pull secrets and namespace provisioning
- Maps health checks to K8s probes

### @opsen/docker

Docker single-host RuntimeDeployer. For each workload:

- Creates a Docker network for inter-container communication
- Creates a Container per process (with optional scaling via instance suffix)
- Creates Docker Volumes for persistent storage
- Injects files via container uploads
- Maps health checks to Docker HEALTHCHECK
- Deploys a Caddy reverse proxy for endpoints that need ingress (auto-TLS via Let's Encrypt)

Designed for development environments and small single-server deployments.

### @opsen/azure

Azure Container Apps RuntimeDeployer. For each workload:

- Creates a separate ContainerApp per process (independent scaling)
- Configures ACA native ingress for external endpoints (auto-TLS, custom domains)
- Maps health checks to ACA probes
- Supports CORS policies, registry credentials, and workload profiles
- Mounts volumes via AzureFile or EmptyDir storage

### @opsen/k8s-ops

Reusable Kubernetes cluster components for common infrastructure needs:

- **cert-manager** — TLS certificate management with configurable issuers
- **ingress-nginx** — NGINX ingress controller
- **external-dns** — Automatic DNS record management (Cloudflare)
- **Prometheus stack** — Monitoring with Prometheus, Grafana, and Alertmanager
- **Loki** — Log aggregation
- **OAuth2 proxy** — Authentication proxy
- **MinIO** — S3-compatible object storage operator
- **Kafka** — Kafka operator (Strimzi)

Provides a `KubernetesOpsDeployer` that orchestrates these components together, built on the `@opsen/base-ops` deployer pipeline.

## How Runtime-Specific Extensions Work

The Workload type is generic over a runtime parameter. Each runtime defines optional fields at four levels:

| Level    | K8s field                    | Docker field                                         | Azure field                                               |
| -------- | ---------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Workload | `_k8s.resources`             | `_docker.restart`, `memoryMb`, `cpus`                | `_aca.workloadProfileName`                                |
| Process  | `_k8s.resources`             | `_docker.restart`, `memoryMb`, `cpus`, `networkMode` | `_aca.minReplicas`, `maxReplicas`, `cpuCores`, `memoryGi` |
| Volume   | `_k8s.storage` (class, size) | `_docker.driver`, `driverOpts`                       | `_aca.storageType`, `storageName`                         |
| Ingress  | `_k8s` (empty for now)       | `_docker.acmeEmail`                                  | `_aca.customDomains`                                      |

These fields are invisible when writing runtime-agnostic code and fully type-checked when targeting a specific runtime.

## Future Directions

- **More runtimes.** AWS ECS/Fargate and Google Cloud Run are natural next targets.
- **Resource providers.** The internal platform that consumes Opsen has resource providers for managed databases, object storage, and email. A generic resource provider interface in `@opsen/platform` could make these shareable.
- **Validation.** Pre-deployment validation that catches misconfigurations (e.g., ingress endpoint without ports, volume mount without volume definition) before `pulumi up`.
- **More FactStore implementations.** HashiCorp Vault (`@opsen/vault-fact-store`) and Azure Key Vault (`@opsen/azure-fact-store`) are implemented. AWS Secrets Manager and other backends are natural extensions.

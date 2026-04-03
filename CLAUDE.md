# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Opsen is a set of TypeScript libraries for Pulumi that separate _what_ you deploy from _where_ you deploy it. You describe your application once (processes, ports, env vars, health checks, volumes, endpoints), choose a runtime deployer (Kubernetes, Docker, Azure Container Apps), and Opsen translates the description into the correct Pulumi resources.

This is a **library monorepo** — there is no CLI. All packages are published to npm under the `@opsen/*` scope.

## Packages

| Package                   | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `@opsen/platform`         | Workload type system, RuntimeDeployer interface, utility types (standalone) |
| `@opsen/base-ops`         | Facts system, deployer pipeline, config management                          |
| `@opsen/k8s`              | Kubernetes runtime deployer + building blocks                               |
| `@opsen/docker`           | Docker single-host deployer with Caddy ingress + building blocks            |
| `@opsen/azure`            | Azure Container Apps + Web App deployers, App Gateway WAF, cert renewal     |
| `@opsen/k8s-ops`          | Generic K8s cluster components (cert-manager, ingress-nginx, monitoring)    |
| `@opsen/cert-renewer`     | ACME certificate renewal CLI and Azure Function for Key Vault + App Gateway |
| `@opsen/vault-fact-store` | HashiCorp Vault KV v2 backend for FactStore                                 |
| `@opsen/azure-fact-store` | Azure Key Vault backend for FactStore                                       |
| `@opsen/docker-compose`   | SSH-based Docker Compose deployer with MirrorState file sync                |
| `@opsen/powerdns`         | Pulumi dynamic providers for PowerDNS authoritative server and Recursor     |
| `@opsen/agent`            | VM deploy agent — Docker Compose, Caddy ingress, PostgreSQL via mTLS        |

### Dependency Graph

```text
@opsen/platform          (standalone — workload types, RuntimeDeployer, interfaces)
@opsen/base-ops          (standalone — facts, modules, pipeline)
@opsen/k8s               → platform
@opsen/docker            → platform
@opsen/azure             → platform, cert-renewer
@opsen/k8s-ops           → platform, k8s
@opsen/vault-fact-store  → base-ops
@opsen/azure-fact-store  → base-ops
@opsen/cert-renewer      (standalone)
@opsen/docker-compose    (standalone)
@opsen/powerdns          (standalone)
@opsen/agent             (standalone — Go binary + Pulumi installer)
```

Inter-package dependencies use `workspace:^` protocol within the monorepo. External consumers can reference opsen packages via `file:` paths during development.

## Common Commands

```bash
pnpm build                    # Build all packages (tsc --build with project references)
pnpm clean                    # Clean all build artifacts
pnpm test                     # Run unit tests (Vitest)
pnpm test:e2e                 # Run e2e tests
pnpm test:all                 # Run all tests (unit + e2e)
pnpm test:watch               # Watch mode
pnpm lint                     # ESLint
pnpm lint:fix                 # ESLint with auto-fix
pnpm format:check             # Prettier check
pnpm format                   # Prettier write
pnpm ts:check                 # TypeScript type checking across all packages
pnpm commit                   # Commitizen guided commit
pnpm changeset                # Create a changeset for versioning
```

## Architecture

### Workload Model

The core abstraction is the `Workload` type in `@opsen/platform`. It describes processes, endpoints, volumes, files, health checks, and environment variables. The type is generic over a runtime parameter — each runtime adds optional typed extension fields (`_k8s`, `_docker`, `_aca`) that are invisible in runtime-agnostic code.

### RuntimeDeployer Interface

Each runtime package implements `RuntimeDeployer` from `@opsen/platform`. It takes a `Workload` and returns a `DeployedWorkload` with resolved endpoints and process handles. The deployer is a pure function of the workload description — no imperative orchestration.

### Building Blocks

Each runtime deployer also exports standalone building-block functions (e.g. `parseResourceRequirements`, `generateCaddyfile`, `buildContainerAppSpec`) that can be used independently without the full deployer pipeline.

### Azure Deployer Hierarchy

All Azure deployers extend `AzureDeployer` base class which manages a shared Azure Native provider keyed by name and provides `options()` helper for provider injection:

- **Infrastructure deployers**: `AppGatewayDeployer`, `CertRenewalFunctionDeployer`, `CertRenewalJobDeployer`, `ContainerAppDeployer`, `WebAppDeployer`
- **Runtime deployers** (implement `RuntimeDeployer`): `AzureRuntimeDeployer` (Container Apps), `AzureWebAppRuntimeDeployer` (Web Apps)

### Facts System

`@opsen/base-ops` provides a typed facts system for passing structured state between Pulumi stacks. Facts are kind+metadata+spec objects indexed in a FactsPool for O(1) lookup by kind+name. FactStore backends: `PulumiFactStore` (built-in), `@opsen/vault-fact-store` (Vault KV v2), `@opsen/azure-fact-store` (Azure Key Vault).

### K8s Ops Components

`@opsen/k8s-ops` provides reusable Kubernetes cluster components (cert-manager, ingress-nginx, external-dns, Prometheus, Loki, OAuth2 proxy, MinIO, Kafka) and a `KubernetesOpsDeployer` that orchestrates them.

### Build System

The root `tsconfig.json` uses TypeScript project references (`composite: true`). `tsc --build` at the root builds all packages in dependency order. Each package has its own `tsconfig.json` extending `tsconfig.base.json`.

## Code Conventions

- **ES Modules** throughout — see ESM rules below
- **Prettier**: single quotes, no semicolons, 120 print width
- **Conventional Commits**: enforced by commitlint + husky (`feat:`, `fix:`, `refactor:`, etc.)
- **Node.js >= 22**, **pnpm >= 10.12.1** (npm/yarn blocked)
- TypeScript strict mode with all strict flags enabled
- Tests use **Vitest** with globals enabled; unit tests are `*.test.ts`, e2e tests are `*.e2e.test.ts`

### ESM and Module Resolution

The root `package.json` has `"type": "module"`. TypeScript uses `module: "nodenext"` / `moduleResolution: "node16"` (via `@tsconfig/node22`).

**Do NOT add `"type": "module"` to sub-package `package.json` files.** Pulumi packages (`@pulumi/kubernetes`, `@pulumi/docker`, `@pulumi/azure-native`) lack proper ESM `exports` maps, so their deep subpath imports (e.g. `@pulumi/azure-native/network`, `@pulumi/kubernetes/types`) break under strict `nodenext` resolution when the consuming package has `type: "module"`. Only `@opsen/agent` and `@opsen/cert-renewer` have it because they don't use Pulumi deep imports.

**Package setup** — every `package.json` under `packages/` MUST have:

- `"main": "src/index.ts"` — for local development / workspace resolution
- `"publishConfig": { "main": "dist/index.js", "types": "dist/index.d.ts" }` — for npm consumers

### Pulumi Input Wrapping for Resource Args

All public `Args` interfaces for Pulumi resources (both `dynamic.Resource` and `ComponentResource`) must wrap fields with `pulumi.Input<>` so consumers can pass Outputs directly without `.apply()`:

- **Scalars**: `pulumi.Input<string>`, `pulumi.Input<number>`, `pulumi.Input<boolean>`
- **Arrays**: double-wrap — `pulumi.Input<pulumi.Input<string>[]>`
- **Records**: double-wrap values — `pulumi.Input<Record<string, pulumi.Input<string>>>`
- **Nested objects**: wrap the object and inner fields — `pulumi.Input<{ field: pulumi.Input<string> }>`

**Dynamic resources** — Pulumi resolves all Inputs recursively before passing to provider methods. Double-wrap freely. Keep a separate plain `ProviderInputs` interface for the provider methods.

**ComponentResources** — fields used in construction-time conditionals or iteration (e.g., `if (args.enabled)`, `for (const x of args.items)`) must stay concrete because an unresolved `Input` (Output/Promise) is always truthy. Wrap everything else. Use `pulumi.all()` to resolve groups of Inputs before accessing their values:

```typescript
const resolved = pulumi.all({ foo: args.foo, bar: args.bar })
// use resolved.apply(({ foo, bar }) => ...) for helm values, etc.
```

## Security

- **No shell command injection** — never interpolate variables into `execSync()` strings. Use `execFileSync(cmd, args[])` with argument arrays instead. This applies to all CLI wrappers (`az`, `hcloud`, `docker`, `ssh`, `kubectl`, etc.) in `@opsen/testing` and e2e tests.
- **No secrets in code** — API tokens, passwords, and private keys must come from environment variables or files, never hardcoded.

## Git Hooks (Husky)

- **pre-commit** — `pnpm lint-staged` (eslint --fix + prettier on staged files) AND `pnpm ts:check`
- **commit-msg** — commitlint enforces Conventional Commits format

If a hook fails, fix the issue and re-stage. Key gotchas:

- ESLint's `markdown/fenced-code-language` rule requires a language tag on ALL fenced code blocks in `.md` files
- lint-staged only checks staged files — unstaged fixes won't be seen
- commitlint rejects non-conventional prefixes — use `chore:` for merge commits

## CI/CD

- **CI** (`ci.yml`) — format:check, lint, ts:check, test, build on push/PR to master
- **Release** (`release.yml`) — changesets action on push to master; creates version PRs or publishes all `@opsen/*` packages to npm
- **Canary** (`canary.yml`) — snapshot publish on PR label `canary`; publishes all packages with canary tag

## Testing Conventions

- **`*.test.ts`** (unit) — Pure logic, mocked dependencies. Runs via `pnpm test`.
- **`*.e2e.test.ts`** (e2e) — Integration tests. Runs via `pnpm test:e2e`.
- All test files live alongside source in `packages/*/src/`.

## Known Issues

See [DEVELOPMENT.md](./DEVELOPMENT.md) for current known issues and development status.

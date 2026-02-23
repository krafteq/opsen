# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Opsen is a set of TypeScript libraries for Pulumi that separate _what_ you deploy from _where_ you deploy it. You describe your application once (processes, ports, env vars, health checks, volumes, endpoints), choose a runtime deployer (Kubernetes, Docker, Azure Container Apps), and Opsen translates the description into the correct Pulumi resources.

This is a **library monorepo** — there is no CLI. All packages are published to npm under the `@opsen/*` scope.

## Packages

| Package           | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `@opsen/infra`    | Facts system, deployer pipeline, config management              |
| `@opsen/platform` | Workload type system, RuntimeDeployer interface, WorkloadModule |
| `@opsen/k8s`      | Kubernetes runtime deployer                                     |
| `@opsen/docker`   | Docker single-host deployer with Caddy ingress                  |
| `@opsen/azure`    | Azure Container Apps runtime deployer                           |

### Dependency Graph

```text
infra <- platform <- k8s
                  <- docker
                  <- azure
```

Inter-package dependencies use `file:` relative paths (not `workspace:*`) so external consumers can reference opsen packages via `file:` during development.

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

### Facts System

`@opsen/infra` provides a typed facts system for passing structured state between Pulumi stacks. Facts are kind+metadata+spec objects indexed in a FactsPool for O(1) lookup by kind+name.

### Build System

The root `tsconfig.json` uses TypeScript project references (`composite: true`). `tsc --build` at the root builds all packages in dependency order. Each package has its own `tsconfig.json` extending `tsconfig.base.json`.

## Code Conventions

- **ES Modules** throughout (`"type": "module"` in root package.json, `verbatimModuleSyntax` in tsconfig)
- **Prettier**: single quotes, no semicolons, 120 print width
- **Conventional Commits**: enforced by commitlint + husky (`feat:`, `fix:`, `refactor:`, etc.)
- **Node.js >= 22**, **pnpm >= 10.12.1** (npm/yarn blocked)
- TypeScript strict mode with all strict flags enabled
- Tests use **Vitest** with globals enabled; unit tests are `*.test.ts`, e2e tests are `*.e2e.test.ts`

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

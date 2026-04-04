# @opsen/platform

## 0.4.0

### Minor Changes

- 0d8136d: Wrap all resource Args fields with `pulumi.Input<>` for consumer flexibility. Arrays and Records are double-wrapped (e.g. `pulumi.Input<pulumi.Input<string>[]>`). Consumers can now pass Outputs directly without `.apply()` wrappers.

## 0.3.1

### Patch Changes

- 9efb80e: feat(azure): add injectable naming convention for Azure resources
  - Add `AzureNaming` interface and `defaultAzureNaming()` for customizable resource naming
  - Default naming: `${deployerName}-${workloadName}-${processName}` (prevents collisions)
  - Add optional `naming` field to `AzureRuntimeDeployerArgs` and `AzureWebAppDeployerArgs`
  - Add optional `name` override to `BuildWebAppSpecOptions`, `BuildContainerAppSpecOptions`, and `BuildAppGatewayEntriesOptions`
  - Expose `storageAccounts` and `hostnameBindings` in `DeployedWebApp` return type
  - Fix `global` → `globalThis` for ESM compatibility in `AzureDeployer` base class

  fix(docker-compose): no-downtime updates and orphan cleanup
  - Use `--remove-orphans` to clean up removed services
  - Make delete command a no-op to prevent tearing down all containers during Pulumi replace
  - Add Hetzner Cloud e2e test infrastructure to `@opsen/testing`
  - Add e2e test verifying no-downtime updates and orphan cleanup on real infra

## 0.3.0

### Minor Changes

- 98d8ae3: Add secret env vars and secret files support to the Workload type system

  Introduces `SecretValue` and `SecretRef` types for env vars and file content, allowing runtimes to use their native secret mechanisms (K8s Secrets, ACA secrets, Azure Key Vault references). Plain string env vars and files continue to work unchanged.

## 0.2.1

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.

## 0.2.0

### Minor Changes

- a8cb2c7: Move runtime-specific types from @opsen/platform to their respective packages (AzureRuntime → @opsen/azure, DockerRuntime → @opsen/docker, KubernetesRuntime → @opsen/k8s). Platform is now standalone with no knowledge of specific runtimes. Also replace `import * as azure from '@pulumi/azure-native'` with targeted submodule imports across all Azure files.

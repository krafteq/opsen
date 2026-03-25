---
'@opsen/azure': minor
'@opsen/platform': patch
'@opsen/docker-compose': patch
---

feat(azure): add injectable naming convention for Azure resources

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

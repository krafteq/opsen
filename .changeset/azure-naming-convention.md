---
'@opsen/azure': minor
'@opsen/platform': patch
---

feat(azure): add injectable naming convention for Azure resources

- Add `AzureNaming` interface and `defaultAzureNaming()` for customizable resource naming
- Default naming: `${deployerName}-${workloadName}-${processName}` (prevents collisions)
- Add optional `naming` field to `AzureRuntimeDeployerArgs` and `AzureWebAppDeployerArgs`
- Add optional `name` override to `BuildWebAppSpecOptions`, `BuildContainerAppSpecOptions`, and `BuildAppGatewayEntriesOptions`
- Expose `storageAccounts` and `hostnameBindings` in `DeployedWebApp` return type
- Fix `global` → `globalThis` for ESM compatibility in `AzureDeployer` base class

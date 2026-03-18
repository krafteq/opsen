import * as pulumi from '@pulumi/pulumi'
import { WebAppSpec, WebAppDeployer, DeployedWebApp } from '../deployer/web-app'

export interface DeployWebAppArgs {
  /** App Service Plan ID */
  appServicePlanId: pulumi.Input<string>
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Key Vault for secret references */
  keyVault: { vaultUrl: string; identityId?: pulumi.Input<string> }
  /** Storage account for Azure Files mounts */
  storageAccount?: { name: string; key: pulumi.Input<string>; shareName: string }
  /** Container registry credentials */
  registry?: {
    server: string
    username?: string
    password?: pulumi.Input<string>
    identityId?: string
  }
}

/**
 * Deploy a single Azure Web App from a `WebAppSpec`.
 *
 * Standalone wrapper around `WebAppDeployer.deploy()` — compose with
 * `buildWebAppSpec()` to go from workload → deployed web app.
 */
export function deployWebApp(spec: WebAppSpec, args: DeployWebAppArgs): DeployedWebApp {
  const deployer = new WebAppDeployer({
    appServicePlanId: args.appServicePlanId,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    keyVault: args.keyVault,
    storageAccount: args.storageAccount,
    registry: args.registry,
  })
  return deployer.deploy(spec)
}

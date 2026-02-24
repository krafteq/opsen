import * as pulumi from '@pulumi/pulumi'
import {
  ContainerAppSpec,
  ContainerAppRegistry,
  ContainerAppDeployer,
  DeployedContainerApp,
} from '../deployer/container-app'

export interface DeployContainerAppArgs {
  /** Azure Container Apps Environment ID */
  environmentId: pulumi.Input<string>
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Container registry credentials */
  registries?: ContainerAppRegistry[]
}

/**
 * Deploy a single Azure Container App from a `ContainerAppSpec`.
 *
 * Standalone wrapper around `ContainerAppDeployer.deploy()` — compose with
 * `buildContainerAppSpec()` to go from workload → deployed app.
 */
export function deployContainerApp(spec: ContainerAppSpec, args: DeployContainerAppArgs): DeployedContainerApp {
  const deployer = new ContainerAppDeployer({
    environmentId: args.environmentId,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    registries: args.registries,
  })
  return deployer.deploy(spec)
}

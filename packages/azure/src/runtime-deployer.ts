import * as pulumi from '@pulumi/pulumi'
import {
  RuntimeDeployer,
  AzureContainerAppsRuntime,
  Workload,
  WorkloadMetadata,
  DeployedWorkload,
  DeployedServiceEndpoint,
} from '@opsen/platform'
import { ContainerAppDeployer, ContainerAppRegistry } from './deployer/container-app'
import { buildContainerAppSpec } from './building-blocks/build-container-app-spec'

export interface AzureRuntimeDeployerArgs {
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
 * Azure Container Apps RuntimeDeployer.
 * Maps each process to a separate ContainerApp for independent scaling.
 * ACA handles ingress natively — no proxy needed.
 */
export class AzureRuntimeDeployer implements RuntimeDeployer<AzureContainerAppsRuntime> {
  readonly runtimeKind = 'azure-aca'

  private deployer: ContainerAppDeployer

  constructor(args: AzureRuntimeDeployerArgs) {
    this.deployer = new ContainerAppDeployer({
      environmentId: args.environmentId,
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      registries: args.registries,
    })
  }

  deploy(workload: Workload<AzureContainerAppsRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload> {
    return pulumi.output(workload).apply((wl) => {
      const processes: Record<string, {}> = {}
      const endpointOutputs: Record<string, pulumi.Input<DeployedServiceEndpoint>> = {}

      // Deploy each process as a separate ContainerApp
      for (const [processName, process] of Object.entries(wl.processes ?? {})) {
        if (process.disabled) continue

        const appName = `${metadata.name}-${processName}`
        const spec = buildContainerAppSpec(wl, metadata, processName, process)
        const deployed = this.deployer.deploy(spec)
        processes[processName] = {}

        // Resolve endpoints targeting this process
        for (const [endpointName, endpoint] of Object.entries(wl.endpoints ?? {})) {
          if (endpoint.backend.process !== processName) continue

          const backendPort = process.ports?.[endpoint.backend.port]
          const port = endpoint.servicePort ?? backendPort?.port ?? 443

          if (endpoint.ingress?.hosts) {
            // External ingress — use the first custom domain or ACA FQDN
            const firstHost = (endpoint.ingress.hosts as string[])[0]
            endpointOutputs[endpointName] = {
              host: firstHost ?? deployed.fqdn,
              port: 443,
            }
          } else {
            // Internal — use ACA FQDN (internal ingress within environment)
            endpointOutputs[endpointName] = deployed.fqdn.apply((fqdn) => ({
              host: fqdn || `${appName}.internal`,
              port,
            }))
          }
        }
      }

      return pulumi.all(endpointOutputs).apply((endpoints) => ({
        processes,
        endpoints,
      }))
    })
  }
}

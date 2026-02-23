import * as pulumi from '@pulumi/pulumi'
import {
  RuntimeDeployer,
  AzureContainerAppsRuntime,
  Workload,
  WorkloadProcess,
  WorkloadMetadata,
  DeployedWorkload,
  DeployedServiceEndpoint,
  Probe,
} from '@opsen/platform'
import {
  ContainerAppDeployer,
  ContainerAppSpec,
  ContainerAppProbeSpec,
  ContainerAppRegistry,
  ContainerAppVolumeSpec,
} from './deployer/container-app'

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
        const spec = this.buildContainerAppSpec(wl, metadata, processName, process)
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

  private buildContainerAppSpec(
    wl: pulumi.Unwrap<Workload<AzureContainerAppsRuntime>>,
    metadata: WorkloadMetadata,
    processName: string,
    process: pulumi.Unwrap<WorkloadProcess<AzureContainerAppsRuntime>>,
  ): ContainerAppSpec {
    const appName = `${metadata.name}-${processName}`

    const image = process.image ?? wl.image
    if (!image) {
      throw new Error(`No image specified for process ${processName} in ${metadata.name}`)
    }

    const env: Record<string, string | undefined> = {
      ...(wl.env ?? {}),
      ...(process.env ?? {}),
    }

    const cmd = process.cmd ?? wl.cmd
    const allFiles = [...(wl.files ?? []), ...(process.files ?? [])]

    // Merge volumes
    const processVolumes = {
      ...(wl.volumes ?? {}),
      ...(process.volumes ?? {}),
    }
    const volumes: ContainerAppVolumeSpec[] = Object.entries(processVolumes).map(([volName, volSpec]) => ({
      name: volName,
      mountPath: volSpec.path,
      storageType: volSpec._aca?.storageType ?? 'EmptyDir',
      storageName: volSpec._aca?.storageName,
    }))

    // Map health probes
    const probes: ContainerAppProbeSpec[] = []
    const healthcheck = {
      ...(wl.healthcheck ?? {}),
      ...(process.healthcheck ?? {}),
    }
    if (healthcheck.liveness) {
      probes.push(this.mapProbe('Liveness', healthcheck.liveness))
    }
    if (healthcheck.readiness) {
      probes.push(this.mapProbe('Readiness', healthcheck.readiness))
    }
    if (healthcheck.startup) {
      probes.push(this.mapProbe('Startup', healthcheck.startup))
    }

    // Resolve ingress from endpoints targeting this process
    let targetPort: number | undefined
    let external = false
    let enableCors = false
    const customDomains: { name: string; certificateId?: string }[] = []

    for (const [, endpoint] of Object.entries(wl.endpoints ?? {})) {
      if (endpoint.backend.process !== processName) continue

      const backendPort = process.ports?.[endpoint.backend.port]
      if (backendPort) {
        targetPort = backendPort.port
      }

      if (endpoint.ingress) {
        external = true
        if (endpoint.ingress.enableCors) enableCors = true

        const hosts = (endpoint.ingress.hosts as string[]) ?? []
        for (const host of hosts) {
          const acaDomains = endpoint.ingress._aca?.customDomains ?? []
          const domainConfig = acaDomains.find((d: { name: string }) => d.name === host)
          customDomains.push({
            name: host,
            certificateId: domainConfig?.certificateId,
          })
        }
      }
    }

    // Scale: process-level overrides workload-level
    const scale = process.scale ?? wl.scale ?? 1
    const minReplicas = process._aca?.minReplicas ?? 0
    const maxReplicas = process._aca?.maxReplicas ?? Math.max(scale, 1)

    return {
      name: appName,
      image: image as string,
      command: cmd as string[] | undefined,
      env,
      cpuCores: process._aca?.cpuCores ?? 0.25,
      memoryGi: process._aca?.memoryGi ?? 0.5,
      minReplicas,
      maxReplicas,
      targetPort,
      external,
      corsPolicy: enableCors
        ? {
            allowedOrigins: ['*'],
            allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['*'],
            allowCredentials: false,
          }
        : undefined,
      customDomains: customDomains.length > 0 ? customDomains : undefined,
      volumes,
      probes,
      files: allFiles.length > 0 ? allFiles : undefined,
      workloadProfileName: wl._aca?.workloadProfileName,
    }
  }

  private mapProbe(type: 'Liveness' | 'Readiness' | 'Startup', probe: Probe): ContainerAppProbeSpec {
    const base: ContainerAppProbeSpec = {
      type,
      initialDelaySeconds: probe.initialDelaySeconds,
      periodSeconds: probe.periodSeconds,
      timeoutSeconds: probe.timeoutSeconds,
      failureThreshold: probe.failureThreshold,
      successThreshold: probe.successThreshold,
    }

    if (probe.action.type === 'http-get') {
      base.httpGet = {
        path: probe.action.httpGet.path,
        port: probe.action.httpGet.port,
      }
    } else if (probe.action.type === 'exec') {
      // ACA doesn't support exec probes — fall back to tcpSocket if we have a port
      // This is a known limitation
      base.tcpSocket = { port: 8080 }
    }

    return base
  }
}

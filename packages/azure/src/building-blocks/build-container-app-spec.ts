import * as pulumi from '@pulumi/pulumi'
import { Workload, WorkloadProcess, WorkloadMetadata, Probe } from '@opsen/platform'
import type { AzureRuntime } from '../runtime'
import { ContainerAppSpec, ContainerAppProbeSpec, ContainerAppVolumeSpec } from '../deployer/container-app'

export interface BuildContainerAppSpecOptions {
  /** Storage account name for persistent AzureFile volumes */
  storageName?: string
  /** Workload profile name for Container Apps */
  workloadProfileName?: string
}

/**
 * Build a `ContainerAppSpec` from a workload, metadata, and a single process.
 *
 * This is a pure data-transform — no cloud resources are created.
 * Use with `ContainerAppDeployer.deploy()` or `deployContainerApp()` to actually deploy.
 */
export function buildContainerAppSpec(
  wl: pulumi.Unwrap<Workload<AzureRuntime>>,
  metadata: WorkloadMetadata,
  processName: string,
  process: pulumi.Unwrap<WorkloadProcess<AzureRuntime>>,
  options?: BuildContainerAppSpecOptions,
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

  const processVolumes = {
    ...(wl.volumes ?? {}),
    ...(process.volumes ?? {}),
  }
  const volumes: ContainerAppVolumeSpec[] = Object.entries(processVolumes).map(([volName, volSpec]) => ({
    name: volName,
    mountPath: volSpec.path,
    storageType: volSpec._az?.persistent ? 'AzureFile' : 'EmptyDir',
    storageName: volSpec._az?.persistent ? options?.storageName : undefined,
  }))

  const probes: ContainerAppProbeSpec[] = []
  const healthcheck = {
    ...(wl.healthcheck ?? {}),
    ...(process.healthcheck ?? {}),
  }
  if (healthcheck.liveness) {
    probes.push(mapProbe('Liveness', healthcheck.liveness))
  }
  if (healthcheck.readiness) {
    probes.push(mapProbe('Readiness', healthcheck.readiness))
  }
  if (healthcheck.startup) {
    probes.push(mapProbe('Startup', healthcheck.startup))
  }

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

      // Skip custom domain binding for WAF endpoints — traffic routes through
      // App Gateway using the Container App's default *.azurecontainerapps.io FQDN as backend.
      if (!endpoint.ingress._az?.waf) {
        const hosts = (endpoint.ingress.hosts as string[]) ?? []
        for (const host of hosts) {
          customDomains.push({ name: host })
        }
      }
    }
  }

  const scale = process.scale ?? wl.scale ?? 1
  const minReplicas = process._az?.minReplicas ?? 0
  const maxReplicas = process._az?.maxReplicas ?? Math.max(scale, 1)

  return {
    name: appName,
    image: image as string,
    command: cmd as string[] | undefined,
    env,
    cpuCores: process._az?.cpu ?? 0.25,
    memoryGi: process._az?.memory ?? 0.5,
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
    workloadProfileName: options?.workloadProfileName,
  }
}

function mapProbe(type: 'Liveness' | 'Readiness' | 'Startup', probe: Probe): ContainerAppProbeSpec {
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
    base.tcpSocket = { port: 8080 }
  }

  return base
}

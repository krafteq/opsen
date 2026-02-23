import * as docker from '@pulumi/docker'
import { input as inputs } from '@pulumi/docker/types'
import * as pulumi from '@pulumi/pulumi'
import {
  DockerRuntime,
  Workload,
  WorkloadProcess,
  WorkloadMetadata,
  DeployedProcess,
  ProcessPortProtocol,
} from '@opsen/platform'

export interface DockerWorkloadDeployerArgs {
  network: docker.Network
  /** Default restart policy for all containers */
  defaultRestart?: string
}

export interface DeployedDockerProcess extends DeployedProcess {
  containers: docker.Container[]
}

export interface DeployedDockerWorkload {
  processes: Record<string, DeployedDockerProcess>
  /** Port mappings for endpoints without ingress: endpointName → host:port */
  directPorts: Record<string, { host: string; port: number }>
  /** Endpoints that need ingress: endpointName → { containerName, containerPort, hosts } */
  ingressTargets: IngressTarget[]
}

export interface IngressTarget {
  endpointName: string
  containerName: string
  containerPort: number
  hosts: string[]
  path: string
  enableCors: boolean
}

export class DockerWorkloadDeployer {
  constructor(private readonly args: DockerWorkloadDeployerArgs) {}

  deploy(workload: Workload<DockerRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedDockerWorkload> {
    return pulumi.output(workload).apply((wl) => {
      const processes: Record<string, DeployedDockerProcess> = {}
      const directPorts: Record<string, { host: string; port: number }> = {}
      const ingressTargets: IngressTarget[] = []

      // Deploy volumes
      const volumeMap: Record<string, docker.Volume> = {}
      for (const [volName, volSpec] of Object.entries(wl.volumes ?? {})) {
        volumeMap[volName] = new docker.Volume(`${metadata.name}-vol-${volName}`, {
          name: `${metadata.name}-${volName}`,
          driver: volSpec._docker?.driver,
          driverOpts: volSpec._docker?.driverOpts,
        })
      }

      // Deploy processes
      for (const [processName, process] of Object.entries(wl.processes ?? {})) {
        if (process.disabled) continue

        const containers = this.deployProcess(wl, metadata, processName, process, volumeMap)
        processes[processName] = { containers }
      }

      // Process endpoints
      for (const [endpointName, endpoint] of Object.entries(wl.endpoints ?? {})) {
        const process = wl.processes?.[endpoint.backend.process]
        if (!process) continue

        const backendPort = process.ports?.[endpoint.backend.port]
        if (!backendPort) continue

        const containerName = `${metadata.name}-${endpoint.backend.process}`

        if (endpoint.ingress?.hosts) {
          ingressTargets.push({
            endpointName,
            containerName,
            containerPort: backendPort.port,
            hosts: endpoint.ingress.hosts as string[],
            path: (endpoint.ingress.path as string) ?? '/',
            enableCors: (endpoint.ingress.enableCors as boolean) ?? false,
          })
        } else {
          const servicePort = endpoint.servicePort ?? backendPort.port
          directPorts[endpointName] = {
            host: '0.0.0.0',
            port: servicePort,
          }
        }
      }

      return { processes, directPorts, ingressTargets }
    })
  }

  private deployProcess(
    workload: pulumi.Unwrap<Workload<DockerRuntime>>,
    metadata: WorkloadMetadata,
    processName: string,
    process: pulumi.Unwrap<WorkloadProcess<DockerRuntime>>,
    volumeMap: Record<string, docker.Volume>,
  ): docker.Container[] {
    const image = process.image ?? workload.image
    if (!image) throw new Error(`No image specified for process ${processName}`)

    const scale = process.scale ?? workload.scale ?? 1
    const restart =
      process._docker?.restart ?? workload._docker?.restart ?? this.args.defaultRestart ?? 'unless-stopped'

    const allFiles = [...(workload.files ?? []), ...(process.files ?? [])]
    const env = {
      ...(workload.env ?? {}),
      ...(process.env ?? {}),
    }
    const processVolumes = {
      ...(workload.volumes ?? {}),
      ...(process.volumes ?? {}),
    }
    const cmd = process.cmd ?? workload.cmd
    const ports = process.ports ?? {}

    const containers: docker.Container[] = []

    for (let i = 0; i < scale; i++) {
      const suffix = scale > 1 ? `-${i}` : ''
      const containerName = `${metadata.name}-${processName}${suffix}`

      // Build port bindings — only expose on host for the first instance
      // (scaled instances are accessible via Docker network by container name)
      const portBindings =
        i === 0
          ? Object.entries(ports).map(([, portDef]) => ({
              internal: portDef.port,
              external: portDef.port,
              protocol: this.mapProtocol(portDef.protocol),
            }))
          : Object.entries(ports).map(([, portDef]) => ({
              internal: portDef.port,
              protocol: this.mapProtocol(portDef.protocol),
            }))

      // Build volume mounts
      const volumes: inputs.ContainerVolume[] = []
      for (const [volName, volSpec] of Object.entries(processVolumes)) {
        const vol = volumeMap[volName]
        if (vol) {
          volumes.push({
            volumeName: vol.name,
            containerPath: volSpec.path,
          })
        }
      }

      // Build file uploads
      const uploads = allFiles.map((file) => ({
        file: file.path,
        content: file.content as string,
      }))

      // Build healthcheck
      const healthcheck = process.healthcheck ?? workload.healthcheck
      let dockerHealthcheck: inputs.ContainerHealthcheck | undefined
      if (healthcheck?.liveness) {
        const probe = healthcheck.liveness
        if (probe.action.type === 'exec') {
          dockerHealthcheck = {
            tests: ['CMD', ...(probe.action.cmd as string[])],
            interval: `${probe.periodSeconds ?? 30}s`,
            timeout: `${probe.timeoutSeconds ?? 5}s`,
            startPeriod: `${probe.initialDelaySeconds ?? 0}s`,
            retries: probe.failureThreshold ?? 3,
          }
        } else if (probe.action.type === 'http-get') {
          dockerHealthcheck = {
            tests: ['CMD', 'curl', '-f', `http://localhost:${probe.action.httpGet.port}${probe.action.httpGet.path}`],
            interval: `${probe.periodSeconds ?? 30}s`,
            timeout: `${probe.timeoutSeconds ?? 5}s`,
            startPeriod: `${probe.initialDelaySeconds ?? 0}s`,
            retries: probe.failureThreshold ?? 3,
          }
        }
      }

      const memoryMb = process._docker?.memoryMb ?? workload._docker?.memoryMb
      const cpus = process._docker?.cpus ?? workload._docker?.cpus

      const container = new docker.Container(containerName, {
        name: containerName,
        image,
        restart,
        command: cmd as string[],
        envs: Object.entries(env)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`),
        ports: portBindings,
        volumes,
        uploads,
        healthcheck: dockerHealthcheck,
        memory: memoryMb,
        cpuShares: cpus ? Math.round(cpus * 1024) : undefined,
        networksAdvanced: [
          {
            name: this.args.network.name,
            aliases: [containerName],
          },
        ],
      })

      containers.push(container)
    }

    return containers
  }

  private mapProtocol(protocol: ProcessPortProtocol): string {
    switch (protocol) {
      case 'udp':
        return 'udp'
      case 'sctp':
        return 'sctp'
      default:
        return 'tcp'
    }
  }
}

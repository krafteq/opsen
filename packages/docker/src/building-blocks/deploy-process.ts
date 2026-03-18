import * as docker from '@pulumi/docker'
import { input as inputs } from '@pulumi/docker/types'
import { Workload, WorkloadProcess, WorkloadMetadata, ProcessPortProtocol } from '@opsen/platform'
import type { DockerRuntime } from '../runtime'
import * as pulumi from '@pulumi/pulumi'

export interface DeployDockerProcessArgs {
  network: docker.Network
  defaultRestart?: string
}

/**
 * Deploy a single Docker process (one or more containers based on scale).
 *
 * This is the standalone equivalent of `DockerWorkloadDeployer.deployProcess()`.
 */
export function deployDockerProcess(
  workload: pulumi.Unwrap<Workload<DockerRuntime>>,
  metadata: WorkloadMetadata,
  processName: string,
  process: pulumi.Unwrap<WorkloadProcess<DockerRuntime>>,
  volumeMap: Record<string, docker.Volume>,
  args: DeployDockerProcessArgs,
): docker.Container[] {
  const image = process.image ?? workload.image
  if (!image) throw new Error(`No image specified for process ${processName}`)

  const scale = process.scale ?? workload.scale ?? 1
  const restart = process._docker?.restart ?? workload._docker?.restart ?? args.defaultRestart ?? 'unless-stopped'

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

    const portBindings =
      i === 0
        ? Object.entries(ports).map(([, portDef]) => ({
            internal: portDef.port,
            external: portDef.port,
            protocol: mapProtocol(portDef.protocol),
          }))
        : Object.entries(ports).map(([, portDef]) => ({
            internal: portDef.port,
            protocol: mapProtocol(portDef.protocol),
          }))

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

    const uploads = allFiles.map((file) => ({
      file: file.path,
      content: file.content as string,
    }))

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
          name: args.network.name,
          aliases: [containerName],
        },
      ],
    })

    containers.push(container)
  }

  return containers
}

function mapProtocol(protocol: ProcessPortProtocol): string {
  switch (protocol) {
    case 'udp':
      return 'udp'
    case 'sctp':
      return 'sctp'
    default:
      return 'tcp'
  }
}

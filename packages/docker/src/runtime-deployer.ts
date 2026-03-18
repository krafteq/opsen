import * as docker from '@pulumi/docker'
import * as pulumi from '@pulumi/pulumi'
import { RuntimeDeployer, Workload, WorkloadMetadata, DeployedWorkload, DeployedServiceEndpoint } from '@opsen/platform'
import type { DockerRuntime } from './runtime'
import { DockerWorkloadDeployer } from './workload/workload-deployer'
import { CaddyIngressDeployer } from './ingress/caddy'

export interface DockerRuntimeDeployerArgs {
  /** Unique name for this Docker environment (used for resource naming) */
  name: string
  /** ACME email for Let's Encrypt certificates via Caddy */
  acmeEmail?: string
  /** Caddy image override */
  caddyImage?: string
  /** Default restart policy */
  defaultRestart?: 'no' | 'always' | 'on-failure' | 'unless-stopped'
}

/**
 * Docker single-host RuntimeDeployer. Orchestrates:
 * 1. Docker network creation
 * 2. Workload containers via DockerWorkloadDeployer
 * 3. Caddy reverse proxy for ingress via CaddyIngressDeployer
 */
export class DockerRuntimeDeployer implements RuntimeDeployer<DockerRuntime> {
  readonly runtimeKind = 'docker'

  private network: docker.Network
  private caddyDeployer: CaddyIngressDeployer

  constructor(private readonly args: DockerRuntimeDeployerArgs) {
    this.network = new docker.Network(`${args.name}-network`, {
      name: `${args.name}-net`,
    })

    this.caddyDeployer = new CaddyIngressDeployer({
      name: args.name,
      network: this.network,
      acmeEmail: args.acmeEmail,
      image: args.caddyImage,
    })
  }

  deploy(workload: Workload<DockerRuntime>, metadata: WorkloadMetadata): pulumi.Output<DeployedWorkload> {
    const workloadDeployer = new DockerWorkloadDeployer({
      network: this.network,
      defaultRestart: this.args.defaultRestart ?? 'unless-stopped',
    })

    return workloadDeployer.deploy(workload, metadata).apply((result) => {
      // Deploy Caddy if there are ingress targets
      if (result.ingressTargets.length > 0) {
        this.caddyDeployer.deploy(result.ingressTargets)
      }

      // Build DeployedWorkload from results
      const processes: Record<string, {}> = {}
      for (const processName of Object.keys(result.processes)) {
        processes[processName] = {}
      }

      const endpoints: Record<string, DeployedServiceEndpoint> = {}

      // Direct port mappings
      for (const [name, mapping] of Object.entries(result.directPorts)) {
        endpoints[name] = { host: mapping.host, port: mapping.port }
      }

      // Ingress targets get the Caddy host
      for (const target of result.ingressTargets) {
        const host = target.hosts[0] ?? 'localhost'
        endpoints[target.endpointName] = { host, port: 443 }
      }

      return { processes, endpoints }
    })
  }
}

import * as docker from '@pulumi/docker'
import * as pulumi from '@pulumi/pulumi'
import { IngressTarget } from '../workload/workload-deployer'

export interface CaddyIngressDeployerArgs {
  /** Name prefix for the Caddy container */
  name: string
  /** Docker network to attach Caddy to */
  network: docker.Network
  /** Email address for ACME / Let's Encrypt */
  acmeEmail?: string
  /** Caddy Docker image. Defaults to "caddy:2" */
  image?: string
}

/**
 * Deploys a Caddy reverse proxy container that routes incoming traffic
 * to backend workload containers based on host matching.
 */
export class CaddyIngressDeployer {
  constructor(private readonly args: CaddyIngressDeployerArgs) {}

  deploy(targets: IngressTarget[]): pulumi.Output<docker.Container> {
    const caddyfile = this.generateCaddyfile(targets)
    const prefix = this.args.name

    const dataVolume = new docker.Volume(`${prefix}-caddy-data`, {
      name: `${prefix}-caddy-data`,
    })
    const configVolume = new docker.Volume(`${prefix}-caddy-config`, {
      name: `${prefix}-caddy-config`,
    })

    const container = new docker.Container(`${prefix}-caddy`, {
      name: `${prefix}-caddy`,
      image: this.args.image ?? 'caddy:2',
      restart: 'unless-stopped',
      ports: [
        { internal: 80, external: 80, protocol: 'tcp' },
        { internal: 443, external: 443, protocol: 'tcp' },
      ],
      uploads: [
        {
          file: '/etc/caddy/Caddyfile',
          content: caddyfile,
        },
      ],
      volumes: [
        {
          volumeName: dataVolume.name,
          containerPath: '/data',
        },
        {
          volumeName: configVolume.name,
          containerPath: '/config',
        },
      ],
      networksAdvanced: [
        {
          name: this.args.network.name,
          aliases: [`${prefix}-caddy`],
        },
      ],
    })

    return pulumi.output(container)
  }

  private generateCaddyfile(targets: IngressTarget[]): string {
    const lines: string[] = []

    // Global options
    if (this.args.acmeEmail) {
      lines.push('{')
      lines.push(`  email ${this.args.acmeEmail}`)
      lines.push('}')
      lines.push('')
    }

    // Per-host site blocks
    const byHost = new Map<string, IngressTarget[]>()
    for (const target of targets) {
      for (const host of target.hosts) {
        const existing = byHost.get(host) ?? []
        existing.push(target)
        byHost.set(host, existing)
      }
    }

    for (const [host, hostTargets] of byHost) {
      lines.push(`${host} {`)
      for (const target of hostTargets) {
        const path = target.path === '/' ? '' : target.path
        const upstream = `${target.containerName}:${target.containerPort}`

        if (target.enableCors) {
          lines.push(`  @cors${sanitize(target.endpointName)} {`)
          lines.push(`    method OPTIONS`)
          if (path) lines.push(`    path ${path}*`)
          lines.push(`  }`)
          lines.push(`  header @cors${sanitize(target.endpointName)} Access-Control-Allow-Origin *`)
          lines.push(
            `  header @cors${sanitize(target.endpointName)} Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS"`,
          )
          lines.push(`  header @cors${sanitize(target.endpointName)} Access-Control-Allow-Headers *`)
        }

        if (path) {
          lines.push(`  handle_path ${path}* {`)
          lines.push(`    reverse_proxy ${upstream}`)
          lines.push(`  }`)
        } else {
          lines.push(`  reverse_proxy ${upstream}`)
        }
      }
      lines.push('}')
      lines.push('')
    }

    return lines.join('\n')
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_')
}

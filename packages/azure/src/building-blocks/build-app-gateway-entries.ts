import * as pulumi from '@pulumi/pulumi'
import { Workload, WorkloadMetadata, WorkloadProcess } from '@opsen/platform'
import type { AzureRuntime } from '../runtime'

/**
 * Describes all App Gateway sub-resource entries for one endpoint.
 * This is a pure data-transform — no cloud resources are created.
 */
export interface AppGatewayEntries {
  /** Unique prefix for sub-resource names (e.g. "myapp-web-public") */
  namePrefix: string
  /** Custom hostname for this endpoint */
  hostName: string
  /** Backend FQDN (Container App / Web App hostname) */
  backendFqdn: string
  /** Backend port (typically 443 for ACA/WebApp HTTPS) */
  backendPort: number
  /** Health probe config, if the workload defines one */
  probe?: {
    protocol: 'Http' | 'Https'
    path: string
    interval?: number
    timeout?: number
    unhealthyThreshold?: number
  }
  /** Priority for the routing rule (caller must ensure uniqueness) */
  priority: number
}

export interface BuildAppGatewayEntriesOptions {
  /** Backend FQDN for the deployed process (ACA FQDN or WebApp default hostname) */
  backendFqdn: string
  /** Starting priority number for routing rules (default 100) */
  basePriority?: number
}

/**
 * Build App Gateway sub-resource entry descriptors from a workload.
 *
 * For each endpoint with `_az.waf: true` targeting `processName`,
 * emits an `AppGatewayEntries` object with all the data needed to
 * create the six sub-resources (listener, pool, settings, rule, probe, ssl cert).
 *
 * This is a pure function — no Pulumi resources or cloud API calls.
 */
export function buildAppGatewayEntries(
  wl: pulumi.Unwrap<Workload<AzureRuntime>>,
  metadata: WorkloadMetadata,
  processName: string,
  process: pulumi.Unwrap<WorkloadProcess<AzureRuntime>>,
  options: BuildAppGatewayEntriesOptions,
): AppGatewayEntries[] {
  const entries: AppGatewayEntries[] = []
  let priority = options.basePriority ?? 100

  for (const [endpointName, endpoint] of Object.entries(wl.endpoints ?? {})) {
    if (endpoint.backend.process !== processName) continue
    if (!endpoint.ingress?._az?.waf) continue

    const hosts = (endpoint.ingress.hosts as string[]) ?? []
    if (hosts.length === 0) continue

    const hostName = hosts[0]
    const namePrefix = `${metadata.name}-${processName}-${endpointName}`

    const backendPort = process.ports?.[endpoint.backend.port]
    const port = endpoint.servicePort ?? backendPort?.port ?? 443

    // Derive probe from workload healthcheck
    const healthcheck = { ...(wl.healthcheck ?? {}), ...(process.healthcheck ?? {}) }
    let probe: AppGatewayEntries['probe']

    if (healthcheck.readiness?.action?.type === 'http-get') {
      probe = {
        protocol: 'Https',
        path: healthcheck.readiness.action.httpGet.path,
        interval: healthcheck.readiness.periodSeconds,
        timeout: healthcheck.readiness.timeoutSeconds,
        unhealthyThreshold: healthcheck.readiness.failureThreshold,
      }
    } else if (healthcheck.liveness?.action?.type === 'http-get') {
      probe = {
        protocol: 'Https',
        path: healthcheck.liveness.action.httpGet.path,
        interval: healthcheck.liveness.periodSeconds,
        timeout: healthcheck.liveness.timeoutSeconds,
        unhealthyThreshold: healthcheck.liveness.failureThreshold,
      }
    }

    entries.push({
      namePrefix,
      hostName,
      backendFqdn: options.backendFqdn,
      backendPort: port,
      probe,
      priority,
    })

    priority += 10
  }

  return entries
}

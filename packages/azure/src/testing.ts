import type { Workload } from '@opsen/platform'
import type { AzureRuntime } from './runtime'

/**
 * Creates an Azure test workload using nginx:alpine.
 * ACA handles port routing internally, so we use port 80.
 * External ingress so we get a public FQDN.
 */
export function createAzureTestWorkload(): {
  workload: Workload<AzureRuntime>
  metadata: { name: string }
} {
  return {
    workload: {
      image: 'nginx:alpine',
      processes: {
        web: {
          ports: {
            http: { port: 80, protocol: 'http' },
          },
          _az: {
            minReplicas: 1,
            maxReplicas: 1,
            cpu: 0.25,
            memory: 0.5,
          },
        },
      },
      endpoints: {
        http: {
          ingress: {
            hosts: [],
          },
          backend: { process: 'web', port: 'http' },
        },
      },
    },
    metadata: { name: 'e2e-test-azure' },
  }
}

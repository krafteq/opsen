import type { Workload } from '@opsen/platform'
import type { KubernetesRuntime } from './runtime'

/**
 * Creates a K8s test workload using nginx:alpine.
 * Placeholder for when a cluster is available.
 */
export function createK8sTestWorkload(): {
  workload: Workload<KubernetesRuntime>
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
        },
      },
      endpoints: {
        http: {
          backend: { process: 'web', port: 'http' },
        },
      },
    },
    metadata: { name: 'e2e-test-k8s' },
  }
}

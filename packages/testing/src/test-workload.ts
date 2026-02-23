import type { Workload } from '@opsen/platform'
import type { DockerRuntime, AzureContainerAppsRuntime, KubernetesRuntime } from '@opsen/platform'

/**
 * Creates a Docker test workload using hashicorp/http-echo.
 * Listens on a high port (15678) to avoid conflicts.
 * Returns configurable text at GET /.
 */
export function createDockerTestWorkload(opts?: { text?: string; port?: number }): {
  workload: Workload<DockerRuntime>
  metadata: { name: string }
} {
  const text = opts?.text ?? 'opsen-e2e-docker-ok'
  const port = opts?.port ?? 15678

  return {
    workload: {
      image: 'hashicorp/http-echo',
      cmd: ['-text', text, '-listen', `:${port}`],
      processes: {
        web: {
          ports: {
            http: { port, protocol: 'http' },
          },
        },
      },
      endpoints: {
        http: {
          servicePort: port,
          backend: { process: 'web', port: 'http' },
        },
      },
      _docker: {
        restart: 'no',
      },
    },
    metadata: { name: 'e2e-test-docker' },
  }
}

/**
 * Creates an Azure test workload using nginx:alpine.
 * ACA handles port routing internally, so we use port 80.
 * External ingress so we get a public FQDN.
 */
export function createAzureTestWorkload(): {
  workload: Workload<AzureContainerAppsRuntime>
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
          _aca: {
            minReplicas: 1,
            maxReplicas: 1,
            cpuCores: 0.25,
            memoryGi: 0.5,
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

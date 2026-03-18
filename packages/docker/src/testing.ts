import type { Workload } from '@opsen/platform'
import type { DockerRuntime } from './runtime'

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

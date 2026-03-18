import * as pulumi from '@pulumi/pulumi'
import type { Workload } from '@opsen/platform'
import { DockerRuntime, DockerRuntimeDeployer } from '@opsen/docker'

// Create a Docker runtime deployer
const runtime = new DockerRuntimeDeployer({
  name: 'myapp',
  acmeEmail: 'admin@example.com',
  defaultRestart: 'unless-stopped',
})

// Define a multi-process workload: web server + background worker
const workload: Workload<DockerRuntime> = {
  image: 'node:22-alpine',

  env: {
    NODE_ENV: 'production',
    REDIS_URL: 'redis://myapp-worker:6379',
  },

  volumes: {
    'app-data': {
      path: '/data',
      size: '1Gi',
    },
  },

  processes: {
    web: {
      cmd: ['node', 'server.js'],
      ports: {
        http: { port: 3000, protocol: 'http' },
      },
      healthcheck: {
        liveness: {
          action: { type: 'http-get', httpGet: { path: '/health', port: 3000 } },
          periodSeconds: 10,
          timeoutSeconds: 3,
          failureThreshold: 3,
        },
      },
      env: {
        PORT: '3000',
      },
    },

    worker: {
      image: 'redis:7-alpine',
      cmd: ['redis-server'],
      ports: {
        redis: { port: 6379, protocol: 'tcp' },
      },
      volumes: {
        'app-data': {
          path: '/data',
          size: '1Gi',
        },
      },
      healthcheck: {
        liveness: {
          action: { type: 'exec', cmd: ['redis-cli', 'ping'] },
          periodSeconds: 15,
          failureThreshold: 3,
        },
      },
      _docker: {
        memoryMb: 256,
      },
    },
  },

  endpoints: {
    'web-public': {
      backend: { process: 'web', port: 'http' },
      ingress: {
        hosts: ['myapp.example.com'],
      },
    },
    'redis-internal': {
      backend: { process: 'worker', port: 'redis' },
      // No ingress — exposed directly on host port
    },
  },
}

// Deploy the workload
const deployed = runtime.deploy(workload, { name: 'myapp' })

// Export useful information
export const webEndpoint = deployed.apply((d) => d.endpoints['web-public'])
export const redisEndpoint = deployed.apply((d) => d.endpoints['redis-internal'])

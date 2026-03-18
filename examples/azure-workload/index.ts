import * as pulumi from '@pulumi/pulumi'
import type { Workload } from '@opsen/platform'
import { AzureRuntime, AzureRuntimeDeployer } from '@opsen/azure'

const config = new pulumi.Config()
const location = config.get('location') ?? 'westeurope'
const resourceGroupName = config.require('resourceGroupName')

// Reference an existing Container Apps Environment
// (create one separately or use: new azure.app.ManagedEnvironment(...))
const environmentId = config.require('environmentId')

// Create the Azure Container Apps runtime deployer
const runtime = new AzureRuntimeDeployer({
  environmentId,
  resourceGroupName,
  location,
  registries: [
    {
      server: 'myregistry.azurecr.io',
      username: 'myuser',
      passwordSecretRef: 'registry-password',
    },
  ],
  workloadProfileName: 'Consumption',
})

// Define a multi-process workload: API + background worker
const workload: Workload<AzureRuntime> = {
  image: 'myregistry.azurecr.io/myapp:latest',

  env: {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
  },

  processes: {
    api: {
      cmd: ['node', 'api.js'],
      ports: {
        http: { port: 8080, protocol: 'http' },
      },
      healthcheck: {
        liveness: {
          action: {
            type: 'http-get',
            httpGet: { path: '/health', port: 8080 },
          },
          periodSeconds: 10,
          failureThreshold: 3,
        },
        readiness: {
          action: {
            type: 'http-get',
            httpGet: { path: '/ready', port: 8080 },
          },
          periodSeconds: 5,
        },
      },
      _az: {
        cpu: 0.5,
        memory: 1,
        minReplicas: 1,
        maxReplicas: 5,
      },
    },

    worker: {
      cmd: ['node', 'worker.js'],
      env: {
        QUEUE_NAME: 'tasks',
      },
      _az: {
        cpu: 0.25,
        memory: 0.5,
        minReplicas: 0,
        maxReplicas: 3,
      },
    },
  },

  volumes: {
    cache: {
      path: '/tmp/cache',
      _az: {
        persistent: false,
      },
    },
  },

  endpoints: {
    'api-public': {
      backend: { process: 'api', port: 'http' },
      ingress: {
        hosts: ['myapp.example.com'],
        enableCors: true,
      },
    },
  },
}

// Deploy the workload
const deployed = runtime.deploy(workload, { name: 'myapp' })

// Export endpoints
export const apiEndpoint = deployed.apply((d) => d.endpoints['api-public'])

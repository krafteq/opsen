import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  isPulumiAvailable,
  isAzureAvailable,
  pulumiTest,
  pulumiDestroy,
  createAzureTestEnvironment,
  destroyAzureTestEnvironment,
  assertHttpEndpoint,
} from '@opsen/testing'
import { createAzureTestWorkload } from '../testing'
import type { AzureTestEnvironment, PulumiTestResult } from '@opsen/testing'
import type { Stack } from '@pulumi/pulumi/automation/index.js'

const canRun = isPulumiAvailable() && isAzureAvailable()

let azureEnv: AzureTestEnvironment | undefined
let testStack: Stack | undefined

beforeAll(async () => {
  if (!canRun) return
  azureEnv = createAzureTestEnvironment({ location: 'eastus' })
}, 600_000)

afterAll(async () => {
  if (testStack) {
    try {
      await pulumiDestroy(testStack)
    } catch (err) {
      console.error('[azure-e2e] pulumi cleanup failed:', err)
    }
  }
  if (azureEnv) {
    destroyAzureTestEnvironment(azureEnv.resourceGroupName)
  }
}, 600_000)

describe.skipIf(!canRun)('AzureRuntimeDeployer e2e', () => {
  it('deploys a container app and serves HTTP traffic', async () => {
    expect(azureEnv).toBeDefined()
    const env = azureEnv!

    const { workload, metadata } = createAzureTestWorkload()

    const result: PulumiTestResult = await pulumiTest({
      projectName: 'opsen-azure-e2e',
      program: async () => {
        const { AzureRuntimeDeployer } = await import('../runtime-deployer.js')

        const deployer = new AzureRuntimeDeployer({
          environmentId: env.environmentId,
          resourceGroupName: env.resourceGroupName,
          location: env.location,
        })

        const deployed = deployer.deploy(workload, metadata)

        return { deployed }
      },
    })

    testStack = result.stack

    // The ACA FQDN is in the deployed output — extract it
    const deployed = result.outputs.deployed as { endpoints: Record<string, { host: string; port: number }> }
    const httpEndpoint = deployed?.endpoints?.http

    expect(httpEndpoint).toBeDefined()
    expect(httpEndpoint.host).toBeTruthy()

    // Verify the nginx welcome page is accessible
    const url = `https://${httpEndpoint.host}`
    await assertHttpEndpoint(url, {
      expectedStatus: 200,
      expectedBodyContains: 'Welcome to nginx',
      timeout: 120_000,
      retryInterval: 5_000,
    })
  })
})

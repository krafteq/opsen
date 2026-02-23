import { describe, it, expect, afterAll } from 'vitest'
import {
  isPulumiAvailable,
  isDockerAvailable,
  pulumiTest,
  pulumiDestroy,
  createDockerTestWorkload,
  assertDockerContainerRunning,
  assertDockerNetworkExists,
  assertHttpEndpoint,
} from '@opsen/testing'
import type { PulumiTestResult } from '@opsen/testing'
import type { Stack } from '@pulumi/pulumi/automation/index.js'

const canRun = isPulumiAvailable() && isDockerAvailable()

let testStack: Stack | undefined

afterAll(async () => {
  if (testStack) {
    try {
      await pulumiDestroy(testStack)
    } catch (err) {
      console.error('[docker-e2e] cleanup failed:', err)
    }
  }
})

describe.skipIf(!canRun)('DockerRuntimeDeployer e2e', () => {
  const expectedText = 'opsen-e2e-docker-ok'
  const testPort = 15678

  it('deploys a workload and serves HTTP traffic', async () => {
    const { workload, metadata } = createDockerTestWorkload({
      text: expectedText,
      port: testPort,
    })

    const result: PulumiTestResult = await pulumiTest({
      projectName: 'opsen-docker-e2e',
      program: async () => {
        const { DockerRuntimeDeployer } = await import('../runtime-deployer.js')

        const deployer = new DockerRuntimeDeployer({
          name: 'e2e-test',
          defaultRestart: 'no',
        })

        const deployed = deployer.deploy(workload, metadata)

        return { deployed }
      },
    })

    testStack = result.stack

    // Verify Docker resources exist
    assertDockerContainerRunning('e2e-test-docker')
    assertDockerNetworkExists('e2e-test-net')

    // Verify HTTP endpoint responds
    const body = await assertHttpEndpoint(`http://localhost:${testPort}`, {
      expectedStatus: 200,
      expectedBodyContains: expectedText,
      timeout: 30_000,
    })

    expect(body).toContain(expectedText)
  })
})

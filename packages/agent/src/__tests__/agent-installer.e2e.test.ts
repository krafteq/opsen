import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { isPulumiAvailable } from '@opsen/testing'
import { LocalWorkspace, Stack } from '@pulumi/pulumi/automation/index.js'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const canRun = isPulumiAvailable()

const GO_OUT_DIR = resolve(import.meta.dirname, '..', '..', 'go', 'out')
const BINARY_PATH = join(GO_OUT_DIR, 'opsen-agent')

let stateDir: string
let stack: Stack | undefined
let binaryExistedBefore: boolean

beforeAll(() => {
  binaryExistedBefore = existsSync(BINARY_PATH)
})

afterAll(async () => {
  if (stack) {
    try {
      await stack.workspace.removeStack(stack.name)
    } catch {
      // stack may not have state to remove
    }
  }
  if (stateDir?.includes('opsen-e2e-')) {
    rmSync(stateDir, { recursive: true, force: true })
  }
  // Clean up placeholder only if binary didn't exist before the test
  if (!binaryExistedBefore && existsSync(BINARY_PATH)) {
    unlinkSync(BINARY_PATH)
  }
})

describe.skipIf(!canRun)('AgentInstaller plan mode e2e', () => {
  it('preview succeeds when binary does not exist (clean checkout)', async () => {
    // Ensure the binary does NOT exist to simulate a clean checkout
    if (existsSync(BINARY_PATH)) {
      unlinkSync(BINARY_PATH)
    }
    expect(existsSync(BINARY_PATH)).toBe(false)

    stateDir = mkdtempSync(join(tmpdir(), 'opsen-e2e-'))
    const stackName = `test-${randomBytes(4).toString('hex')}`

    stack = await LocalWorkspace.createStack(
      {
        projectName: 'opsen-agent-plan-e2e',
        stackName,
        program: async () => {
          const { AgentInstaller } = await import('../agent-installer.js')

          new AgentInstaller('test-agent', {
            connection: {
              host: '127.0.0.1',
              user: 'root',
              privateKey: 'fake-key',
            },
            config: {
              listen: '0.0.0.0:8443',
              roles: {
                compose: {},
              },
            },
            tls: {
              ca: 'fake-ca',
              cert: 'fake-cert',
              key: 'fake-key',
            },
          })

          return {}
        },
      },
      {
        workDir: stateDir,
        envVars: {
          PULUMI_BACKEND_URL: `file://${stateDir}`,
          PULUMI_CONFIG_PASSPHRASE: 'test',
        },
      },
    )

    // preview() is the plan/dry-run equivalent — no resources are created
    const result = await stack.preview()

    // Preview should report resources to create (no errors)
    expect(result.changeSummary.create).toBeGreaterThan(0)

    // The placeholder file should have been created by the constructor
    expect(existsSync(BINARY_PATH)).toBe(true)
  })

  it('preview succeeds when binary already exists', async () => {
    // The placeholder was created by the previous test (or we write one ourselves)
    expect(existsSync(BINARY_PATH)).toBe(true)

    stateDir = mkdtempSync(join(tmpdir(), 'opsen-e2e-'))
    const stackName = `test-${randomBytes(4).toString('hex')}`

    stack = await LocalWorkspace.createStack(
      {
        projectName: 'opsen-agent-plan-e2e',
        stackName,
        program: async () => {
          const { AgentInstaller } = await import('../agent-installer.js')

          new AgentInstaller('test-agent', {
            connection: {
              host: '127.0.0.1',
              user: 'root',
              privateKey: 'fake-key',
            },
            config: {
              listen: '0.0.0.0:8443',
              roles: {
                compose: {},
              },
            },
            tls: {
              ca: 'fake-ca',
              cert: 'fake-cert',
              key: 'fake-key',
            },
          })

          return {}
        },
      },
      {
        workDir: stateDir,
        envVars: {
          PULUMI_BACKEND_URL: `file://${stateDir}`,
          PULUMI_CONFIG_PASSPHRASE: 'test',
        },
      },
    )

    const result = await stack.preview()
    expect(result.changeSummary.create).toBeGreaterThan(0)
  })
})

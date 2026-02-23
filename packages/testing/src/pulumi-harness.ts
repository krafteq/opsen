import { LocalWorkspace, Stack } from '@pulumi/pulumi/automation/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface PulumiTestOptions {
  /** Name prefix for the Pulumi project */
  projectName: string
  /** Inline Pulumi program */
  program: () => Promise<Record<string, unknown>>
  /** Optional stack name (random if omitted) */
  stackName?: string
}

export interface PulumiTestResult<T = Record<string, unknown>> {
  outputs: T
  stack: Stack
}

/**
 * Run a Pulumi inline program with a file:// backend, returning outputs.
 * Cleans up (destroy + remove stack + temp dir) in a finally block.
 */
export async function pulumiTest<T = Record<string, unknown>>(opts: PulumiTestOptions): Promise<PulumiTestResult<T>> {
  const stateDir = mkdtempSync(join(tmpdir(), 'opsen-e2e-'))
  const stackName = opts.stackName ?? `test-${randomBytes(4).toString('hex')}`

  let stack: Stack | undefined

  try {
    stack = await LocalWorkspace.createStack(
      {
        projectName: opts.projectName,
        stackName,
        program: opts.program,
      },
      {
        workDir: stateDir,
        envVars: {
          PULUMI_BACKEND_URL: `file://${stateDir}`,
          PULUMI_CONFIG_PASSPHRASE: 'test',
        },
      },
    )

    const upResult = await stack.up({ onOutput: console.log })

    const outputs: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(upResult.outputs)) {
      outputs[key] = val.value
    }

    return { outputs: outputs as T, stack }
  } catch (err) {
    // On failure, still try to destroy resources
    if (stack) {
      try {
        console.log('[pulumi-harness] up failed, attempting destroy...')
        await stack.destroy({ onOutput: console.log })
      } catch (destroyErr) {
        console.error('[pulumi-harness] destroy after failure also failed:', destroyErr)
      }
    }
    throw err
  }
}

/**
 * Destroy a Pulumi stack and clean up the temp state directory.
 */
export async function pulumiDestroy(stack: Stack): Promise<void> {
  await stack.destroy({ onOutput: console.log })
  await stack.workspace.removeStack(stack.name)

  // Clean up the workspace dir (which is our temp state dir)
  const workDir = stack.workspace.workDir
  if (workDir.includes('opsen-e2e-')) {
    rmSync(workDir, { recursive: true, force: true })
  }
}

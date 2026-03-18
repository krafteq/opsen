import { describe, it, expect, vi, beforeEach } from 'vitest'

const { isDryRunMock, createOutput, resolveOutput } = vi.hoisted(() => {
  const isDryRunMock = vi.fn()
  const outputValues = new WeakMap<object, unknown>()

  function createOutput(val: unknown): any {
    if (val && typeof val === 'object' && outputValues.has(val)) return val

    const output = {
      apply(fn: (v: any) => any) {
        const result = fn(val)
        if (result && typeof result === 'object' && outputValues.has(result)) return result
        return createOutput(result)
      },
    }
    outputValues.set(output, val)
    return output
  }

  function resolveOutput(x: unknown): unknown {
    if (x && typeof x === 'object' && outputValues.has(x)) return outputValues.get(x)
    return x
  }

  return { isDryRunMock, createOutput, resolveOutput }
})

vi.mock('@pulumi/pulumi', () => ({
  getOrganization: () => 'org',
  getProject: () => 'project',
  getStack: () => 'stack',
  output: (val: unknown) => {
    if (val && typeof val === 'object' && val === resolveOutput(val)) return createOutput(val)
    return val
  },
  all: (arr: unknown[]) => createOutput(arr.map(resolveOutput)),
  secret: (val: unknown) => createOutput(val),
  runtime: { isDryRun: isDryRunMock },
  Input: {},
  Output: {},
  StackReference: class {
    getOutput() {
      return createOutput(undefined)
    }
  },
}))

import { InfrastructureDeployer } from '../deployer.js'
import { InfrastructureFactsPool } from '../facts-pool.js'
import type { FactsApi } from '../facts-api.js'

class TestDeployer extends InfrastructureDeployer<FactsApi> {
  protected createFactsApi(facts: InfrastructureFactsPool): FactsApi {
    return { pool: facts }
  }
}

describe('InfrastructureDeployer', () => {
  beforeEach(() => {
    isDryRunMock.mockReset()
  })

  describe('dry-run guard', () => {
    it('does not call factSink.write during preview (isDryRun=true)', () => {
      isDryRunMock.mockReturnValue(true)
      const writer = { write: vi.fn().mockResolvedValue(undefined) }

      const deployer = new TestDeployer({ factSink: writer })
      deployer.deploy(() => {})

      expect(writer.write).not.toHaveBeenCalled()
    })

    it('calls factSink.write during up (isDryRun=false)', () => {
      isDryRunMock.mockReturnValue(false)
      const writer = { write: vi.fn().mockResolvedValue(undefined) }

      const deployer = new TestDeployer({ factSink: writer })
      deployer.deploy(() => {})

      expect(writer.write).toHaveBeenCalledTimes(1)
    })

    it('passes the final config containing exposed facts to factSink.write', () => {
      isDryRunMock.mockReturnValue(false)
      const writer = { write: vi.fn().mockResolvedValue(undefined) }

      const deployer = new TestDeployer({ factSink: writer })
      deployer.deploy((ctx) => {
        ctx.expose({ kind: 'cluster', metadata: { name: 'prod' }, spec: { region: 'us-east-1' } })
      })

      expect(writer.write).toHaveBeenCalledWith(
        expect.objectContaining({
          facts: expect.arrayContaining([
            expect.objectContaining({ kind: 'cluster', metadata: { name: 'prod' }, owner: 'org/project/stack' }),
          ]),
        }),
      )
    })

    it('does not write when no factSink is configured', () => {
      isDryRunMock.mockReturnValue(false)

      const deployer = new TestDeployer({})
      const result = deployer.deploy(() => {})

      expect(result).toBeDefined()
    })
  })
})

import { describe, expect, it } from 'vitest'
import { serializeAgentConfig, serializeClientPolicy } from '../config'

describe('agent config serialization', () => {
  it('defaults the global pid_limit to 256', () => {
    const yaml = serializeAgentConfig({
      listen: '0.0.0.0:8443',
      roles: {
        compose: {},
      },
    })

    expect(yaml).toContain('pid_limit: 256')
  })

  it('preserves an explicit global pid_limit', () => {
    const yaml = serializeAgentConfig({
      listen: '0.0.0.0:8443',
      roles: {
        compose: {},
      },
      globalHardening: {
        pidLimit: 512,
      },
    })

    expect(yaml).toContain('pid_limit: 512')
  })
})

describe('client policy serialization', () => {
  it('serializes per-container default_pids and max_pids', () => {
    const yaml = serializeClientPolicy({
      name: 'acme',
      compose: {
        perContainer: {
          defaultPids: 384,
          maxPids: 512,
        },
      },
    })

    expect(yaml).toContain('default_pids: 384')
    expect(yaml).toContain('max_pids: 512')
  })
})

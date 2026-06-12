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

  it('defaults the chown_init_image to busybox', () => {
    const yaml = serializeAgentConfig({
      listen: '0.0.0.0:8443',
      roles: {
        compose: {},
      },
    })

    expect(yaml).toContain('chown_init_image: busybox')
  })

  it('preserves an explicit chown_init_image', () => {
    const yaml = serializeAgentConfig({
      listen: '0.0.0.0:8443',
      roles: {
        compose: {},
      },
      globalHardening: {
        chownInitImage: 'registry.internal/util/busybox:1.36',
      },
    })

    expect(yaml).toContain('chown_init_image: "registry.internal/util/busybox:1.36"')
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

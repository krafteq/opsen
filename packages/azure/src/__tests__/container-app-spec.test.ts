import { describe, it, expect, vi } from 'vitest'

// Mock Pulumi before any imports that use it
vi.mock('@pulumi/pulumi', () => ({
  output: (x: any) => ({ apply: (fn: any) => fn(x) }),
  Input: {},
  Output: { create: (x: any) => x },
  interpolate: (strings: TemplateStringsArray, ...values: any[]) =>
    strings.reduce((r, s, i) => r + s + (values[i] ?? ''), ''),
}))

import { buildContainerAppSpec } from '../building-blocks/build-container-app-spec'

describe('buildContainerAppSpec', () => {
  it('builds basic spec from workload and process', () => {
    const workload = {
      image: 'myapp:latest',
      env: { SHARED: 'yes' },
      processes: {
        web: {
          ports: { http: { port: 3000, protocol: 'http' as const } },
          env: { PORT: '3000' },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildContainerAppSpec(workload as any, metadata, 'web', process)

    expect(spec.name).toBe('myapp-web')
    expect(spec.image).toBe('myapp:latest')
    expect(spec.env).toEqual({ SHARED: 'yes', PORT: '3000' })
    expect(spec.cpuCores).toBe(0.25)
    expect(spec.memoryGi).toBe(0.5)
  })

  it('sets external ingress when endpoint has hosts', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 3000, protocol: 'http' as const } },
        },
      },
      endpoints: {
        public: {
          backend: { process: 'web', port: 'http' },
          ingress: {
            hosts: ['app.example.com'],
            enableCors: true,
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildContainerAppSpec(workload as any, metadata, 'web', process)

    expect(spec.external).toBe(true)
    expect(spec.targetPort).toBe(3000)
    expect(spec.corsPolicy).toBeDefined()
    expect(spec.corsPolicy?.allowedOrigins).toEqual(['*'])
    expect(spec.customDomains).toEqual([{ name: 'app.example.com' }])
  })

  it('maps liveness probe to spec', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 3000, protocol: 'http' as const } },
          healthcheck: {
            liveness: {
              action: { type: 'http-get' as const, httpGet: { path: '/health', port: 3000 } },
              periodSeconds: 10,
              failureThreshold: 3,
            },
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildContainerAppSpec(workload as any, metadata, 'web', process)

    expect(spec.probes).toHaveLength(1)
    expect(spec.probes![0].type).toBe('Liveness')
    expect(spec.probes![0].httpGet).toEqual({ path: '/health', port: 3000 })
  })

  it('respects process-level image override', () => {
    const workload = {
      image: 'default:latest',
      processes: {
        worker: {
          image: 'worker:v2',
          ports: {},
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.worker as any

    const spec = buildContainerAppSpec(workload as any, metadata, 'worker', process)

    expect(spec.image).toBe('worker:v2')
  })

  it('uses custom name when provided in options', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 3000, protocol: 'http' as const } },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildContainerAppSpec(workload as any, metadata, 'web', process, {
      name: 'cookie-consent-myapp-web',
    })

    expect(spec.name).toBe('cookie-consent-myapp-web')
  })

  it('throws when no image specified', () => {
    const workload = {
      processes: {
        web: { ports: {} },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    expect(() => buildContainerAppSpec(workload as any, metadata, 'web', process)).toThrow(
      'No image specified for process web in myapp',
    )
  })
})

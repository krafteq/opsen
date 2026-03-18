import { describe, it, expect, vi } from 'vitest'

// Mock Pulumi before any imports that use it
vi.mock('@pulumi/pulumi', () => ({
  output: (x: any) => ({ apply: (fn: any) => fn(x) }),
  Input: {},
  Output: { create: (x: any) => x },
  interpolate: (strings: TemplateStringsArray, ...values: any[]) =>
    strings.reduce((r, s, i) => r + s + (values[i] ?? ''), ''),
}))

import { buildWebAppSpec } from '../building-blocks/build-webapp-spec'

describe('buildWebAppSpec', () => {
  const defaultOptions = {
    kvVaultUrl: 'https://myvault.vault.azure.net',
  }

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

    const spec = buildWebAppSpec(workload as any, metadata, 'web', process, defaultOptions)

    expect(spec.name).toBe('myapp-web')
    expect(spec.image).toBe('myapp:latest')
    expect(spec.appSettings).toEqual({ SHARED: 'yes', PORT: '3000' })
    expect(spec.alwaysOn).toBe(true)
  })

  it('extracts health check path from liveness probe', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 3000, protocol: 'http' as const } },
          healthcheck: {
            liveness: {
              action: { type: 'http-get' as const, httpGet: { path: '/health', port: 3000 } },
              periodSeconds: 10,
            },
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildWebAppSpec(workload as any, metadata, 'web', process, defaultOptions)

    expect(spec.healthCheckPath).toBe('/health')
  })

  it('extracts port and custom hostnames from endpoints', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 8080, protocol: 'http' as const } },
        },
      },
      endpoints: {
        public: {
          backend: { process: 'web', port: 'http' },
          ingress: {
            hosts: ['app.example.com', 'www.example.com'],
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildWebAppSpec(workload as any, metadata, 'web', process, defaultOptions)

    expect(spec.port).toBe(8080)
    expect(spec.customHostnames).toEqual(['app.example.com', 'www.example.com'])
  })

  it('maps persistent volumes to Azure Files storage mounts', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: {},
          volumes: {
            data: {
              path: '/app/data',
              _az: { persistent: true },
            },
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildWebAppSpec(workload as any, metadata, 'web', process, {
      ...defaultOptions,
      storageAccount: { name: 'mystorage', key: 'secret-key', shareName: 'myshare' },
    })

    expect(spec.storageMounts).toHaveLength(1)
    expect(spec.storageMounts![0]).toEqual({
      name: 'data',
      mountPath: '/app/data',
      shareName: 'myshare',
      storageAccountName: 'mystorage',
      storageAccountKey: 'secret-key',
      accessMode: 'ReadWrite',
    })
  })

  it('skips persistent volume mounts when no storageAccount provided', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: {},
          volumes: {
            data: {
              path: '/app/data',
              _az: { persistent: true },
            },
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildWebAppSpec(workload as any, metadata, 'web', process, defaultOptions)

    expect(spec.storageMounts).toBeUndefined()
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

    const spec = buildWebAppSpec(workload as any, metadata, 'worker', process, defaultOptions)

    expect(spec.image).toBe('worker:v2')
  })

  it('throws when no image specified', () => {
    const workload = {
      processes: {
        web: { ports: {} },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    expect(() => buildWebAppSpec(workload as any, metadata, 'web', process, defaultOptions)).toThrow(
      'No image specified for process web in myapp',
    )
  })

  it('ignores endpoints targeting other processes', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 3000, protocol: 'http' as const } },
        },
      },
      endpoints: {
        api: {
          backend: { process: 'api', port: 'http' },
          ingress: { hosts: ['api.example.com'] },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const spec = buildWebAppSpec(workload as any, metadata, 'web', process, defaultOptions)

    expect(spec.port).toBeUndefined()
    expect(spec.customHostnames).toBeUndefined()
  })
})

import { describe, it, expect, vi } from 'vitest'

vi.mock('@pulumi/pulumi', () => ({
  output: (x: any) => ({ apply: (fn: any) => fn(x) }),
  Input: {},
  Output: { create: (x: any) => x },
  interpolate: (strings: TemplateStringsArray, ...values: any[]) =>
    strings.reduce((r, s, i) => r + s + (values[i] ?? ''), ''),
}))

import { buildAppGatewayEntries } from '../building-blocks/build-app-gateway-entries'

describe('buildAppGatewayEntries', () => {
  it('returns entries for WAF-enabled endpoints', () => {
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
            hosts: ['app.example.com'],
            _az: { waf: true },
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const entries = buildAppGatewayEntries(workload as any, metadata, 'web', process, {
      backendFqdn: 'myapp-web.happyhill-abc123.westeurope.azurecontainerapps.io',
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].namePrefix).toBe('myapp-web-public')
    expect(entries[0].hostName).toBe('app.example.com')
    expect(entries[0].backendFqdn).toBe('myapp-web.happyhill-abc123.westeurope.azurecontainerapps.io')
    expect(entries[0].backendPort).toBe(8080)
    expect(entries[0].priority).toBe(100)
    expect(entries[0].probe).toBeUndefined()
  })

  it('skips endpoints without waf hint', () => {
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
            hosts: ['app.example.com'],
          },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
    })

    expect(entries).toHaveLength(0)
  })

  it('skips endpoints targeting a different process', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 8080, protocol: 'http' as const } },
        },
        worker: {
          ports: {},
        },
      },
      endpoints: {
        public: {
          backend: { process: 'worker', port: 'http' },
          ingress: {
            hosts: ['app.example.com'],
            _az: { waf: true },
          },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
    })

    expect(entries).toHaveLength(0)
  })

  it('derives probe from readiness healthcheck', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 8080, protocol: 'http' as const } },
          healthcheck: {
            readiness: {
              action: { type: 'http-get' as const, httpGet: { path: '/ready', port: 8080 } },
              periodSeconds: 15,
              timeoutSeconds: 5,
              failureThreshold: 2,
            },
          },
        },
      },
      endpoints: {
        public: {
          backend: { process: 'web', port: 'http' },
          ingress: {
            hosts: ['app.example.com'],
            _az: { waf: true },
          },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
    })

    expect(entries[0].probe).toEqual({
      protocol: 'Https',
      path: '/ready',
      interval: 15,
      timeout: 5,
      unhealthyThreshold: 2,
    })
  })

  it('falls back to liveness probe when no readiness', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 8080, protocol: 'http' as const } },
          healthcheck: {
            liveness: {
              action: { type: 'http-get' as const, httpGet: { path: '/health', port: 8080 } },
              periodSeconds: 30,
            },
          },
        },
      },
      endpoints: {
        public: {
          backend: { process: 'web', port: 'http' },
          ingress: {
            hosts: ['app.example.com'],
            _az: { waf: true },
          },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
    })

    expect(entries[0].probe?.path).toBe('/health')
  })

  it('assigns incrementing priorities', () => {
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
          ingress: { hosts: ['app.example.com'], _az: { waf: true } },
        },
        api: {
          backend: { process: 'web', port: 'http' },
          ingress: { hosts: ['api.example.com'], _az: { waf: true } },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
      basePriority: 200,
    })

    expect(entries).toHaveLength(2)
    expect(entries[0].priority).toBe(200)
    expect(entries[1].priority).toBe(210)
  })

  it('uses servicePort when specified', () => {
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
          servicePort: 9090,
          ingress: { hosts: ['app.example.com'], _az: { waf: true } },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
    })

    expect(entries[0].backendPort).toBe(9090)
  })

  it('uses custom resourceName in namePrefix when provided', () => {
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
            hosts: ['app.example.com'],
            _az: { waf: true },
          },
        },
      },
    }

    const metadata = { name: 'myapp' }
    const process = workload.processes.web as any

    const entries = buildAppGatewayEntries(workload as any, metadata, 'web', process, {
      backendFqdn: 'backend.fqdn',
      resourceName: 'cookie-consent-myapp-web',
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].namePrefix).toBe('cookie-consent-myapp-web-public')
  })

  it('skips WAF endpoints without hosts', () => {
    const workload = {
      image: 'myapp:latest',
      processes: {
        web: {
          ports: { http: { port: 8080, protocol: 'http' as const } },
        },
      },
      endpoints: {
        internal: {
          backend: { process: 'web', port: 'http' },
          ingress: { _az: { waf: true } },
        },
      },
    }

    const entries = buildAppGatewayEntries(workload as any, { name: 'myapp' }, 'web', workload.processes.web as any, {
      backendFqdn: 'backend.fqdn',
    })

    expect(entries).toHaveLength(0)
  })
})

import { describe, it, expect } from 'vitest'
import { generateCaddyfile } from '../building-blocks/caddy'
import { IngressTarget } from '../workload/workload-deployer'

describe('generateCaddyfile', () => {
  it('generates a single-host reverse proxy', () => {
    const targets: IngressTarget[] = [
      {
        endpointName: 'web',
        containerName: 'myapp-web',
        containerPort: 3000,
        hosts: ['example.com'],
        path: '/',
        enableCors: false,
      },
    ]

    const result = generateCaddyfile(targets)

    expect(result).toContain('example.com {')
    expect(result).toContain('reverse_proxy myapp-web:3000')
    expect(result).not.toContain('handle_path')
  })

  it('generates path-based routing', () => {
    const targets: IngressTarget[] = [
      {
        endpointName: 'api',
        containerName: 'myapp-api',
        containerPort: 8080,
        hosts: ['example.com'],
        path: '/api',
        enableCors: false,
      },
    ]

    const result = generateCaddyfile(targets)

    expect(result).toContain('handle_path /api* {')
    expect(result).toContain('reverse_proxy myapp-api:8080')
  })

  it('generates multi-host config', () => {
    const targets: IngressTarget[] = [
      {
        endpointName: 'web',
        containerName: 'myapp-web',
        containerPort: 3000,
        hosts: ['example.com', 'www.example.com'],
        path: '/',
        enableCors: false,
      },
    ]

    const result = generateCaddyfile(targets)

    expect(result).toContain('example.com {')
    expect(result).toContain('www.example.com {')
  })

  it('generates CORS headers when enabled', () => {
    const targets: IngressTarget[] = [
      {
        endpointName: 'api',
        containerName: 'myapp-api',
        containerPort: 8080,
        hosts: ['api.example.com'],
        path: '/',
        enableCors: true,
      },
    ]

    const result = generateCaddyfile(targets)

    expect(result).toContain('@corsapi')
    expect(result).toContain('method OPTIONS')
    expect(result).toContain('Access-Control-Allow-Origin *')
    expect(result).toContain('Access-Control-Allow-Methods')
    expect(result).toContain('Access-Control-Allow-Headers *')
  })

  it('includes ACME email in global options', () => {
    const targets: IngressTarget[] = [
      {
        endpointName: 'web',
        containerName: 'myapp-web',
        containerPort: 3000,
        hosts: ['example.com'],
        path: '/',
        enableCors: false,
      },
    ]

    const result = generateCaddyfile(targets, { acmeEmail: 'admin@example.com' })

    expect(result).toContain('{')
    expect(result).toContain('email admin@example.com')
  })

  it('handles empty targets', () => {
    const result = generateCaddyfile([])
    expect(result).toBe('')
  })
})

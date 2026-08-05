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

  describe('backendProtocol', () => {
    // The two inputs below differ only in `backendProtocol`.
    const base: IngressTarget = {
      endpointName: 'grpc',
      containerName: 'app',
      containerPort: 8080,
      hosts: ['app.example.com'],
      path: '/',
      enableCors: false,
    }

    it('emits a bare upstream when the field is absent', () => {
      expect(reverseProxyLines(generateCaddyfile([base]))).toEqual(['  reverse_proxy app:8080'])
    })

    it("emits an h2c:// upstream when the field is 'h2c'", () => {
      const h2c: IngressTarget = { ...base, backendProtocol: 'h2c' }
      expect(reverseProxyLines(generateCaddyfile([h2c]))).toEqual(['  reverse_proxy h2c://app:8080'])
    })

    it("treats an explicit 'http' as byte-identical to the default", () => {
      const explicit: IngressTarget = { ...base, backendProtocol: 'http' }
      expect(generateCaddyfile([explicit])).toBe(generateCaddyfile([base]))
    })

    it('throws when h2c is combined with a path prefix, naming the endpoint', () => {
      const h2cWithPath: IngressTarget = { ...base, backendProtocol: 'h2c', path: '/api' }
      expect(() => generateCaddyfile([h2cWithPath])).toThrow(/grpc/)
      expect(() => generateCaddyfile([h2cWithPath])).toThrow(/h2c/)
    })

    it('allows h2c on a root path', () => {
      const rootPath: IngressTarget = { ...base, backendProtocol: 'h2c', path: '/' }
      expect(reverseProxyLines(generateCaddyfile([rootPath]))).toEqual(['  reverse_proxy h2c://app:8080'])
    })
  })
})

/** Every `reverse_proxy` line of a Caddyfile, indentation included. */
function reverseProxyLines(caddyfile: string): string[] {
  return caddyfile.split('\n').filter((line) => line.trim().startsWith('reverse_proxy'))
}

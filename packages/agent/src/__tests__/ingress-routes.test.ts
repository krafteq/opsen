import { describe, it, expect } from 'vitest'
import { toApiRoute } from '../resources/ingress-routes'

describe('toApiRoute', () => {
  const base = {
    name: 'grpc',
    domain: 'app.example.com',
    upstream: 'app:8080',
  }

  it('omits backend_protocol when the route does not opt in', () => {
    const body = JSON.stringify({ routes: [toApiRoute(base)] })

    expect(JSON.parse(body)).toEqual({
      routes: [{ name: 'grpc', hosts: ['app.example.com'], upstream: 'app:8080' }],
    })
    expect(body).not.toContain('backend_protocol')
  })

  it("sends backend_protocol: 'h2c' on the wire", () => {
    const route = { ...base, backendProtocol: 'h2c' as const }

    // The JSON body the dynamic provider PUTs to /v1/ingress/apps/:app/routes.
    // The Go handler test (h2c_test.go, wireRouteH2C) consumes this exact shape.
    const body = JSON.stringify({ routes: [toApiRoute(route)] }, null, 2)

    expect(body).toContain('"backend_protocol": "h2c"')
    expect(JSON.parse(body)).toEqual({
      routes: [
        {
          name: 'grpc',
          hosts: ['app.example.com'],
          upstream: 'app:8080',
          backend_protocol: 'h2c',
        },
      ],
    })
  })

  it("sends backend_protocol: 'http' when stated explicitly", () => {
    const route = { ...base, backendProtocol: 'http' as const }

    expect(toApiRoute(route).backend_protocol).toBe('http')
  })

  it('maps backend_protocol alongside the other snake_case fields', () => {
    const route = {
      ...base,
      path: '/api',
      bind: '127.0.0.1',
      rateLimit: 10,
      backendProtocol: 'h2c' as const,
    }

    expect(toApiRoute(route)).toMatchObject({
      path_prefix: '/api',
      bind_address: '127.0.0.1',
      rate_limit_rps: 10,
      backend_protocol: 'h2c',
    })
  })
})

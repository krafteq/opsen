import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @pulumi/pulumi
vi.mock('@pulumi/pulumi', () => ({
  output: (x: any) => ({ apply: (fn: any) => fn(x) }),
  all: (obj: any) => ({ apply: (fn: any) => fn(obj) }),
  secret: (x: any) => x,
  Input: {},
  Output: { create: (x: any) => x },
  dynamic: { Resource: class {} },
  interpolate: (strings: TemplateStringsArray, ...values: any[]) =>
    strings.reduce((r, s, i) => r + s + (values[i] ?? ''), ''),
}))

import { createSubResourceProvider } from '../app-gateway/providers/app-gateway-sub-resource'

const testConnection = {
  subscriptionId: 'sub-123',
  resourceGroupName: 'rg-test',
  tenantId: 'tenant-123',
  clientId: 'client-123',
  clientSecret: 'secret-123',
}

function createMockResponse(status: number, data: unknown, etag?: string) {
  const text = JSON.stringify(data)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => data,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) },
  }
}

/** Azure API responses queued per test (token requests handled automatically) */
let apiResponses: Array<{ status: number; data: unknown; etag?: string } | Error>
let capturedApiBodies: any[]

describe('createSubResourceProvider', () => {
  const provider = createSubResourceProvider({
    arrayProperty: 'httpListeners',
    displayName: 'HTTP Listener',
  })

  beforeEach(() => {
    apiResponses = []
    capturedApiBodies = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        // Token requests → always succeed
        if (typeof url === 'string' && url.includes('login.microsoftonline.com')) {
          return createMockResponse(200, { access_token: 'test-token', expires_in: 3600 })
        }

        // Azure management API requests
        if (init?.body) {
          capturedApiBodies.push(JSON.parse(init.body as string))
        }

        const response = apiResponses.shift()
        if (!response) throw new Error(`No more mock responses for ${init?.method} ${url}`)
        if (response instanceof Error) throw response

        return createMockResponse(response.status, response.data, response.etag)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('create: adds entry to gateway array', async () => {
    apiResponses = [
      { status: 200, data: { properties: { httpListeners: [] } }, etag: '"etag-1"' },
      { status: 200, data: { id: 'updated' }, etag: '"etag-2"' },
    ]

    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'my-listener', properties: { hostName: 'app.example.com' } },
    }

    const result = await provider.create!(inputs)

    expect(result.id).toBe('my-gw/httpListeners/my-listener')
    expect(result.outs).toEqual(inputs)
    expect(capturedApiBodies[0].properties.httpListeners).toHaveLength(1)
    expect(capturedApiBodies[0].properties.httpListeners[0].name).toBe('my-listener')
  })

  it('create: updates existing entry with same name', async () => {
    apiResponses = [
      {
        status: 200,
        data: {
          properties: {
            httpListeners: [{ name: 'my-listener', properties: { hostName: 'old.example.com' } }],
          },
        },
        etag: '"etag-1"',
      },
      { status: 200, data: { id: 'updated' }, etag: '"etag-2"' },
    ]

    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'my-listener', properties: { hostName: 'new.example.com' } },
    }

    await provider.create!(inputs)

    expect(capturedApiBodies[0].properties.httpListeners).toHaveLength(1)
    expect(capturedApiBodies[0].properties.httpListeners[0].properties.hostName).toBe('new.example.com')
  })

  it('delete: removes entry from gateway array', async () => {
    apiResponses = [
      {
        status: 200,
        data: {
          properties: {
            httpListeners: [
              { name: 'keep-me', properties: {} },
              { name: 'delete-me', properties: {} },
            ],
          },
        },
        etag: '"etag-1"',
      },
      { status: 200, data: { id: 'updated' }, etag: '"etag-2"' },
    ]

    await provider.delete!('my-gw/httpListeners/delete-me', {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'delete-me', properties: {} },
    })

    expect(capturedApiBodies[0].properties.httpListeners).toHaveLength(1)
    expect(capturedApiBodies[0].properties.httpListeners[0].name).toBe('keep-me')
  })

  it('retries on 412 (etag mismatch)', async () => {
    apiResponses = [
      // First attempt: GET succeeds, PUT fails with 412
      { status: 200, data: { properties: { httpListeners: [] } }, etag: '"etag-1"' },
      new Error('Azure API PUT ... returned 412: Precondition Failed'),
      // Retry: GET + PUT succeed
      { status: 200, data: { properties: { httpListeners: [] } }, etag: '"etag-new"' },
      { status: 200, data: { id: 'updated' }, etag: '"etag-2"' },
    ]

    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'retry-listener', properties: {} },
    }

    const result = await provider.create!(inputs)
    expect(result.id).toBe('my-gw/httpListeners/retry-listener')

    // 2 GET + 2 PUT = 4 Azure API calls (plus token requests)
    expect(capturedApiBodies).toHaveLength(2) // 2 PUT bodies captured
  })

  it('diff: detects entry changes', async () => {
    const result = await provider.diff!(
      'id',
      {
        connection: testConnection,
        gatewayName: 'my-gw',
        entry: { name: 'listener', properties: { hostName: 'old.com' } },
      },
      {
        connection: testConnection,
        gatewayName: 'my-gw',
        entry: { name: 'listener', properties: { hostName: 'new.com' } },
      },
    )

    expect(result.changes).toBe(true)
    expect(result.replaces).toEqual([])
  })

  it('diff: marks gatewayName change as replace', async () => {
    const result = await provider.diff!(
      'id',
      {
        connection: testConnection,
        gatewayName: 'gw-old',
        entry: { name: 'listener', properties: {} },
      },
      {
        connection: testConnection,
        gatewayName: 'gw-new',
        entry: { name: 'listener', properties: {} },
      },
    )

    expect(result.changes).toBe(true)
    expect(result.replaces).toContain('gatewayName')
  })

  it('diff: no changes when identical', async () => {
    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'listener', properties: { hostName: 'app.com' } },
    }

    const result = await provider.diff!('id', inputs, inputs)

    expect(result.changes).toBe(false)
  })
})

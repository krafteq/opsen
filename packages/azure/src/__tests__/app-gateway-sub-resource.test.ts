import { describe, it, expect, vi, beforeEach } from 'vitest'

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

// Mock the azure-connection module to avoid token caching issues
vi.mock('../app-gateway/azure-connection', () => ({
  getAzureToken: vi.fn().mockResolvedValue('test-token'),
  azureApiRequest: vi.fn(),
  ARM_SCOPE: 'https://management.azure.com/.default',
}))

import { createSubResourceProvider } from '../app-gateway/providers/app-gateway-sub-resource'
import { azureApiRequest } from '../app-gateway/azure-connection'

const mockAzureApiRequest = vi.mocked(azureApiRequest)

const testConnection = {
  subscriptionId: 'sub-123',
  resourceGroupName: 'rg-test',
  tenantId: 'tenant-123',
  clientId: 'client-123',
  clientSecret: 'secret-123',
}

describe('createSubResourceProvider', () => {
  const provider = createSubResourceProvider({
    arrayProperty: 'httpListeners',
    displayName: 'HTTP Listener',
  })

  beforeEach(() => {
    mockAzureApiRequest.mockReset()
  })

  it('create: adds entry to gateway array', async () => {
    let capturedBody: any

    mockAzureApiRequest
      // GET gateway
      .mockResolvedValueOnce({
        status: 200,
        data: { properties: { httpListeners: [] } },
        etag: '"etag-1"',
      })
      // PUT gateway
      .mockImplementationOnce(async (_method, _url, _token, body) => {
        capturedBody = body
        return { status: 200, data: { id: 'updated' }, etag: '"etag-2"' }
      })

    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'my-listener', properties: { hostName: 'app.example.com' } },
    }

    const result = await provider.create!(inputs)

    expect(result.id).toBe('my-gw/httpListeners/my-listener')
    expect(result.outs).toEqual(inputs)
    expect(capturedBody.properties.httpListeners).toHaveLength(1)
    expect(capturedBody.properties.httpListeners[0].name).toBe('my-listener')
  })

  it('create: updates existing entry with same name', async () => {
    let capturedBody: any

    mockAzureApiRequest
      .mockResolvedValueOnce({
        status: 200,
        data: {
          properties: {
            httpListeners: [{ name: 'my-listener', properties: { hostName: 'old.example.com' } }],
          },
        },
        etag: '"etag-1"',
      })
      .mockImplementationOnce(async (_method, _url, _token, body) => {
        capturedBody = body
        return { status: 200, data: { id: 'updated' }, etag: '"etag-2"' }
      })

    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'my-listener', properties: { hostName: 'new.example.com' } },
    }

    await provider.create!(inputs)

    expect(capturedBody.properties.httpListeners).toHaveLength(1)
    expect(capturedBody.properties.httpListeners[0].properties.hostName).toBe('new.example.com')
  })

  it('delete: removes entry from gateway array', async () => {
    let capturedBody: any

    mockAzureApiRequest
      .mockResolvedValueOnce({
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
      })
      .mockImplementationOnce(async (_method, _url, _token, body) => {
        capturedBody = body
        return { status: 200, data: { id: 'updated' }, etag: '"etag-2"' }
      })

    await provider.delete!('my-gw/httpListeners/delete-me', {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'delete-me', properties: {} },
    })

    expect(capturedBody.properties.httpListeners).toHaveLength(1)
    expect(capturedBody.properties.httpListeners[0].name).toBe('keep-me')
  })

  it('retries on 412 (etag mismatch)', async () => {
    mockAzureApiRequest
      // First attempt: GET + PUT (fails with 412)
      .mockResolvedValueOnce({
        status: 200,
        data: { properties: { httpListeners: [] } },
        etag: '"etag-1"',
      })
      .mockRejectedValueOnce(new Error('Azure API PUT ... returned 412: Precondition Failed'))
      // Retry: GET + PUT (success)
      .mockResolvedValueOnce({
        status: 200,
        data: { properties: { httpListeners: [] } },
        etag: '"etag-new"',
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { id: 'updated' },
        etag: '"etag-2"',
      })

    const inputs = {
      connection: testConnection,
      gatewayName: 'my-gw',
      entry: { name: 'retry-listener', properties: {} },
    }

    const result = await provider.create!(inputs)
    expect(result.id).toBe('my-gw/httpListeners/retry-listener')

    // 2 GET calls + 2 PUT calls = 4 azureApiRequest calls
    expect(mockAzureApiRequest).toHaveBeenCalledTimes(4)
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

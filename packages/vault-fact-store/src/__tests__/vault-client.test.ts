import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VaultKV2Client } from '../vault-client.js'

describe('VaultKV2Client', () => {
  let client: VaultKV2Client
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    client = new VaultKV2Client({
      address: 'https://vault.example.com',
      token: 'test-token',
      mount: 'opsen',
    })
  })

  describe('get', () => {
    it('returns data on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { kind: 'cluster', spec: {} } } }),
      })

      const result = await client.get('facts/cluster/prod')
      expect(result).toEqual({ kind: 'cluster', spec: {} })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vault.example.com/v1/opsen/data/facts/cluster/prod',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'X-Vault-Token': 'test-token' }),
        }),
      )
    })

    it('returns null on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
      expect(await client.get('facts/cluster/missing')).toBeNull()
    })

    it('throws on other errors', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })
      await expect(client.get('facts/cluster/prod')).rejects.toThrow('Vault GET')
    })
  })

  describe('put', () => {
    it('sends POST with data wrapper', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 })

      await client.put('facts/cluster/prod', { kind: 'cluster' })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vault.example.com/v1/opsen/data/facts/cluster/prod',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ data: { kind: 'cluster' } }),
        }),
      )
    })

    it('throws on error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' })
      await expect(client.put('facts/cluster/prod', {})).rejects.toThrow('Vault PUT')
    })
  })

  describe('delete', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 204 })
      await client.delete('facts/cluster/prod')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vault.example.com/v1/opsen/data/facts/cluster/prod',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })

    it('ignores 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
      await expect(client.delete('facts/cluster/missing')).resolves.toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns keys on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { keys: ['cluster/', 'database/'] } }),
      })

      const keys = await client.list('facts')
      expect(keys).toEqual(['cluster/', 'database/'])
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vault.example.com/v1/opsen/metadata/facts',
        expect.objectContaining({ method: 'LIST' }),
      )
    })

    it('returns empty array on 404', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
      expect(await client.list('facts/empty')).toEqual([])
    })

    it('returns empty array on 403', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' })
      expect(await client.list('facts/restricted')).toEqual([])
    })
  })

  describe('options', () => {
    it('includes namespace header when provided', async () => {
      const nsClient = new VaultKV2Client({
        address: 'https://vault.example.com',
        token: 'test-token',
        mount: 'opsen',
        namespace: 'admin/team',
      })

      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
      await nsClient.get('test')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Vault-Namespace': 'admin/team' }),
        }),
      )
    })

    it('supports async token function', async () => {
      const tokenFn = vi.fn().mockResolvedValue('dynamic-token')
      const dynClient = new VaultKV2Client({
        address: 'https://vault.example.com',
        token: tokenFn,
        mount: 'opsen',
      })

      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
      await dynClient.get('test')

      expect(tokenFn).toHaveBeenCalled()
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Vault-Token': 'dynamic-token' }),
        }),
      )
    })

    it('strips trailing slashes from address', async () => {
      const slashClient = new VaultKV2Client({
        address: 'https://vault.example.com///',
        token: 'test-token',
        mount: 'opsen',
      })

      mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' })
      await slashClient.get('test')

      expect(mockFetch).toHaveBeenCalledWith('https://vault.example.com/v1/opsen/data/test', expect.any(Object))
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConnection } from './types'
import { agentRequest } from './resources/client'
import { getDatabaseAccessRole, putDatabaseAccessRole, revokeDatabaseAccessRole } from './database-access'

vi.mock('./resources/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resources/client')>()),
  agentRequest: vi.fn(),
}))
const request = vi.mocked(agentRequest)
const connection = { endpoint: 'https://agent', caCert: 'ca', clientCert: 'cert', clientKey: 'key' } as AgentConnection
const input = { password: 'random-password-example', access_mode: 'read' as const, expires_at: '2099-01-01T00:00:00Z' }

describe('temporary database access', () => {
  beforeEach(() => vi.resetAllMocks())
  it.each([404, 403, 500])('does not send credentials to an unsupported agent (%s)', async (status) => {
    request.mockResolvedValue({ status, body: {} })
    await expect(putDatabaseAccessRole(connection, 'app', 'lease', input)).rejects.toThrow('upgrade')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(connection, 'GET', '/v1/db/capabilities')
  })
  it('requires the precise capability and preserves the immutable body', async () => {
    request.mockResolvedValueOnce({ status: 200, body: { capabilities: ['temporary-access-roles-v1'] } })
    request.mockResolvedValueOnce({ status: 200, body: { role: 'lease', status: 'active' } })
    await expect(putDatabaseAccessRole(connection, 'app', 'lease', input)).resolves.toMatchObject({ status: 'active' })
    expect(request).toHaveBeenLastCalledWith(connection, 'PUT', '/v1/db/databases/app/access-roles/lease', input)
  })
  it('does not interpret a failed revocation as success', async () => {
    request.mockResolvedValueOnce({ status: 200, body: { capabilities: ['temporary-access-roles-v1'] } })
    request.mockResolvedValueOnce({ status: 500, body: { error: 'revocation incomplete' } })
    await expect(revokeDatabaseAccessRole(connection, 'app', 'lease')).rejects.toThrow('revocation incomplete')
  })
  it('returns null for an absent role', async () => {
    request.mockImplementation(async (_connection, _method, path) =>
      path === '/v1/db/capabilities'
        ? { status: 200, body: { capabilities: ['temporary-access-roles-v1'] } }
        : { status: 404, body: {} },
    )
    await expect(getDatabaseAccessRole(connection, 'app', 'lease')).resolves.toBeNull()
    await expect(revokeDatabaseAccessRole(connection, 'app', 'lease')).resolves.toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConnection } from '../types'
import { agentRequest } from '../resources/client'
import { composeStart, composeStop, ingressStart, ingressStop } from '../lifecycle'

vi.mock('../resources/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/client')>()),
  agentRequest: vi.fn(),
}))

const request = vi.mocked(agentRequest)
const connection: AgentConnection = {
  endpoint: 'https://agent.example.com:9443',
  caCert: 'ca',
  clientCert: 'cert',
  clientKey: 'key',
}

beforeEach(() => request.mockReset())

describe('agent lifecycle helpers', () => {
  it.each([
    [
      composeStop,
      '/v1/compose/projects/my%20app/stop',
      { status: 'stopped', project: 'opsen-client-my-app', stopped: true },
    ],
    [
      composeStart,
      '/v1/compose/projects/my%20app/start',
      { status: 'started', project: 'opsen-client-my-app', stopped: false },
    ],
    [ingressStop, '/v1/ingress/apps/my%20app/stop', { status: 'stopped', app: 'my app', stopped: true }],
    [ingressStart, '/v1/ingress/apps/my%20app/start', { status: 'started', app: 'my app', stopped: false }],
  ] as const)('posts the scoped operation and returns its result: %s', async (operation, path, body) => {
    request.mockResolvedValue({ status: 200, body })
    expect(await operation(connection, 'my app')).toEqual(body)
    expect(request).toHaveBeenCalledExactlyOnceWith(connection, 'POST', path)
  })

  it.each([composeStop, composeStart, ingressStop, ingressStart])(
    'propagates a missing resource instead of treating it as stopped: %s',
    async (operation) => {
      request.mockResolvedValue({ status: 404, body: { error: 'not found' } })
      await expect(operation(connection, 'missing')).rejects.toThrow('Agent API returned 404')
    },
  )

  it('keeps ingress and workload agent calls separate', async () => {
    request.mockResolvedValue({ status: 200, body: { status: 'stopped', stopped: true } })
    await composeStop(connection, 'web')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][2]).toBe('/v1/compose/projects/web/stop')
  })
})

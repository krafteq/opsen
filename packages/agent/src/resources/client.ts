/**
 * Shared mTLS HTTP client for dynamic provider methods.
 *
 * Uses dynamic `import('node:https')` so that the module reference
 * is never captured by Pulumi's closure serializer.
 */

import type { AgentConnection } from '../types.js'

export type { AgentConnection }

export async function agentRequest(
  conn: AgentConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const https = await import('node:https')
  const url = await import('node:url')

  const parsed = new url.URL(path, conn.endpoint)

  const options: import('node:https').RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method,
    ca: conn.caCert,
    cert: conn.clientCert,
    key: conn.clientKey,
    headers: { 'Content-Type': 'application/json' },
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = raw
        }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    if (body !== undefined) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

export function checkResponse(resp: { status: number; body: unknown }, expectedStatuses: number[]): void {
  if (!expectedStatuses.includes(resp.status)) {
    const msg = typeof resp.body === 'object' && resp.body !== null ? JSON.stringify(resp.body) : String(resp.body)
    throw new Error(`Agent API returned ${resp.status}: ${msg}`)
  }
}

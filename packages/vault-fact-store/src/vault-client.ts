export interface VaultKV2ClientOptions {
  address: string
  token: string | (() => Promise<string>)
  namespace?: string
  mount: string
}

interface VaultKV2Data {
  data: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/**
 * Thin wrapper over Vault KV v2 HTTP API using native fetch.
 */
export class VaultKV2Client {
  private readonly address: string
  private readonly tokenSource: string | (() => Promise<string>)
  private readonly namespace: string | undefined
  private readonly mount: string

  constructor(options: VaultKV2ClientOptions) {
    this.address = options.address.replace(/\/+$/, '')
    this.tokenSource = options.token
    this.namespace = options.namespace
    this.mount = options.mount
  }

  /** Read a secret. Returns null if not found. */
  async get(path: string): Promise<Record<string, unknown> | null> {
    const res = await this.request('GET', `${this.mount}/data/${path}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Vault GET ${path}: ${res.status} ${res.statusText}`)
    const body = (await res.json()) as { data: VaultKV2Data }
    return body.data.data
  }

  /** Write a secret. */
  async put(path: string, data: Record<string, unknown>): Promise<void> {
    const res = await this.request('POST', `${this.mount}/data/${path}`, { data })
    if (!res.ok) throw new Error(`Vault PUT ${path}: ${res.status} ${res.statusText}`)
  }

  /** Delete a secret (soft-delete the latest version). */
  async delete(path: string): Promise<void> {
    const res = await this.request('DELETE', `${this.mount}/data/${path}`)
    if (res.status === 404) return
    if (!res.ok) throw new Error(`Vault DELETE ${path}: ${res.status} ${res.statusText}`)
  }

  /** List keys at a path. Returns empty array on 404 or 403. */
  async list(path: string): Promise<string[]> {
    const res = await this.request('LIST', `${this.mount}/metadata/${path}`)
    if (res.status === 404 || res.status === 403) return []
    if (!res.ok) throw new Error(`Vault LIST ${path}: ${res.status} ${res.statusText}`)
    const body = (await res.json()) as { data: { keys: string[] } }
    return body.data.keys
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
    const token = typeof this.tokenSource === 'function' ? await this.tokenSource() : this.tokenSource
    const headers: Record<string, string> = {
      'X-Vault-Token': token,
      'Content-Type': 'application/json',
    }
    if (this.namespace) {
      headers['X-Vault-Namespace'] = this.namespace
    }
    return fetch(`${this.address}/v1/${path}`, {
      method: method === 'LIST' ? 'LIST' : method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  }
}

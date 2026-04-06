import * as pulumi from '@pulumi/pulumi'
import type { AgentConnection, AgentConnectionArgs, DatabaseLimitsArgs, DatabaseOwnerArgs } from '../types'

async function agentRequest(
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

function checkResponse(resp: { status: number; body: unknown }, expectedStatuses: number[]): void {
  if (!expectedStatuses.includes(resp.status)) {
    const msg = typeof resp.body === 'object' && resp.body !== null ? JSON.stringify(resp.body) : String(resp.body)
    throw new Error(`Agent API returned ${resp.status}: ${msg}`)
  }
}

interface DatabaseInputs {
  connection: AgentConnection
  name: string
  owner: {
    username: string
    password: string
  }
  limits?: {
    maxSizeMb?: number
    connectionLimit?: number
    statementTimeout?: string
    workMem?: string
    tempFileLimit?: string
  }
  extensions?: string[]
}

const databaseProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: DatabaseInputs) {
    const resp = await agentRequest(inputs.connection, 'PUT', `/v1/db/databases/${inputs.name}`, {
      owner: inputs.owner,
      limits: inputs.limits,
      extensions: inputs.extensions,
    })
    checkResponse(resp, [200, 201])
    return {
      id: inputs.name,
      outs: { ...inputs, createResult: resp.body },
    }
  },

  async read(id, props: DatabaseInputs) {
    const resp = await agentRequest(props.connection, 'GET', `/v1/db/databases/${id}`)
    if (resp.status === 404) {
      return { id: '', props: {} }
    }
    return { id, props: { ...props, statusResult: resp.body } }
  },

  async update(_id, olds: DatabaseInputs, news: DatabaseInputs) {
    // If only limits changed, use PATCH
    if (
      olds.name === news.name &&
      olds.owner.username === news.owner.username &&
      JSON.stringify(olds.extensions) === JSON.stringify(news.extensions)
    ) {
      const resp = await agentRequest(news.connection, 'PATCH', `/v1/db/databases/${news.name}`, {
        limits: news.limits,
      })
      checkResponse(resp, [200])
      return { outs: { ...news, updateResult: resp.body } }
    }

    // Otherwise full replace via PUT
    const resp = await agentRequest(news.connection, 'PUT', `/v1/db/databases/${news.name}`, {
      owner: news.owner,
      limits: news.limits,
      extensions: news.extensions,
    })
    checkResponse(resp, [200, 201])
    return { outs: { ...news, createResult: resp.body } }
  },

  async delete(id, props: DatabaseInputs) {
    const resp = await agentRequest(props.connection, 'DELETE', `/v1/db/databases/${id}`)
    checkResponse(resp, [200, 404])
  },

  async diff(_id, olds: DatabaseInputs, news: DatabaseInputs) {
    const replaces: string[] = []

    if (olds.name !== news.name) {
      replaces.push('name')
    }
    if (olds.owner?.username !== news.owner?.username) {
      replaces.push('owner')
    }

    const changes =
      replaces.length > 0 ||
      olds.owner?.password !== news.owner?.password ||
      JSON.stringify(olds.limits) !== JSON.stringify(news.limits) ||
      JSON.stringify(olds.extensions) !== JSON.stringify(news.extensions) ||
      olds.connection.endpoint !== news.connection.endpoint

    return { changes, replaces }
  },
}

export interface DatabaseArgs {
  connection: pulumi.Input<AgentConnectionArgs>
  name: pulumi.Input<string>
  owner: pulumi.Input<DatabaseOwnerArgs>
  limits?: pulumi.Input<DatabaseLimitsArgs>
  extensions?: pulumi.Input<pulumi.Input<string>[]>
}

export class Database extends pulumi.dynamic.Resource {
  declare readonly name: pulumi.Output<string>
  declare readonly owner: pulumi.Output<{ username: string; password: string }>
  declare readonly createResult: pulumi.Output<unknown>

  constructor(name: string, args: DatabaseArgs, opts?: pulumi.CustomResourceOptions) {
    super(databaseProvider, name, { ...args, createResult: undefined }, opts)
  }
}

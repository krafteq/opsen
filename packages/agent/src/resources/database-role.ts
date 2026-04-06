import * as pulumi from '@pulumi/pulumi'
import type { AgentConnection, AgentConnectionArgs } from '../types'

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

interface DatabaseRoleInputs {
  connection: AgentConnection
  database: string
  role: string
  password: string
  readOnly: boolean
}

const databaseRoleProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: DatabaseRoleInputs) {
    const resp = await agentRequest(
      inputs.connection,
      'PUT',
      `/v1/db/databases/${inputs.database}/roles/${inputs.role}`,
      {
        password: inputs.password,
        read_only: inputs.readOnly,
      },
    )
    checkResponse(resp, [200, 201])
    return {
      id: `${inputs.database}/${inputs.role}`,
      outs: { ...inputs, createResult: resp.body },
    }
  },

  async read(id, props: DatabaseRoleInputs) {
    const resp = await agentRequest(props.connection, 'GET', `/v1/db/databases/${props.database}/roles/${props.role}`)
    if (resp.status === 404) {
      return { id: '', props: {} }
    }
    return { id, props: { ...props, statusResult: resp.body } }
  },

  async update(_id, _olds: DatabaseRoleInputs, news: DatabaseRoleInputs) {
    // All changes trigger a replace via diff, so this is a full PUT
    const resp = await agentRequest(news.connection, 'PUT', `/v1/db/databases/${news.database}/roles/${news.role}`, {
      password: news.password,
      read_only: news.readOnly,
    })
    checkResponse(resp, [200, 201])
    return { outs: { ...news, createResult: resp.body } }
  },

  async delete(_id, props: DatabaseRoleInputs) {
    const resp = await agentRequest(
      props.connection,
      'DELETE',
      `/v1/db/databases/${props.database}/roles/${props.role}`,
    )
    checkResponse(resp, [200, 404])
  },

  async diff(_id, olds: DatabaseRoleInputs, news: DatabaseRoleInputs) {
    const replaces: string[] = []

    if (olds.database !== news.database) {
      replaces.push('database')
    }
    if (olds.role !== news.role) {
      replaces.push('role')
    }
    if (olds.readOnly !== news.readOnly) {
      replaces.push('readOnly')
    }

    const changes =
      replaces.length > 0 || olds.password !== news.password || olds.connection.endpoint !== news.connection.endpoint

    return { changes, replaces }
  },
}

export interface DatabaseRoleArgs {
  connection: pulumi.Input<AgentConnectionArgs>
  database: pulumi.Input<string>
  role: pulumi.Input<string>
  password: pulumi.Input<string>
  readOnly?: pulumi.Input<boolean>
}

export class DatabaseRole extends pulumi.dynamic.Resource {
  declare readonly database: pulumi.Output<string>
  declare readonly role: pulumi.Output<string>
  declare readonly createResult: pulumi.Output<unknown>

  constructor(name: string, args: DatabaseRoleArgs, opts?: pulumi.CustomResourceOptions) {
    super(databaseRoleProvider, name, { ...args, readOnly: args.readOnly ?? false, createResult: undefined }, opts)
  }
}

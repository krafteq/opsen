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

interface ComposeProjectInputs {
  connection: AgentConnection
  project: string
  files: Record<string, string>
}

const composeProjectProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: ComposeProjectInputs) {
    const resp = await agentRequest(inputs.connection, 'PUT', `/v1/compose/projects/${inputs.project}`, {
      files: inputs.files,
    })
    checkResponse(resp, [200])
    const body = resp.body as Record<string, unknown>
    return {
      id: inputs.project,
      outs: { ...inputs, deployResult: body, ports: body.ports },
    }
  },

  async read(id, props: ComposeProjectInputs) {
    const resp = await agentRequest(props.connection, 'GET', `/v1/compose/projects/${id}`)
    if (resp.status === 404) {
      return { id: '', props: {} }
    }
    return { id, props: { ...props, statusResult: resp.body } }
  },

  async update(_id, _olds: ComposeProjectInputs, news: ComposeProjectInputs) {
    const resp = await agentRequest(news.connection, 'PUT', `/v1/compose/projects/${news.project}`, {
      files: news.files,
    })
    checkResponse(resp, [200])
    const body = resp.body as Record<string, unknown>
    return { outs: { ...news, deployResult: body, ports: body.ports } }
  },

  async delete(id, props: ComposeProjectInputs) {
    const resp = await agentRequest(props.connection, 'DELETE', `/v1/compose/projects/${id}`)
    checkResponse(resp, [200, 404])
  },

  async diff(_id, olds: ComposeProjectInputs, news: ComposeProjectInputs) {
    const replaces: string[] = []
    if (olds.project !== news.project) {
      replaces.push('project')
    }

    const changes =
      replaces.length > 0 ||
      JSON.stringify(olds.files) !== JSON.stringify(news.files) ||
      olds.connection.endpoint !== news.connection.endpoint

    return { changes, replaces }
  },
}

export interface ComposeProjectArgs {
  connection: pulumi.Input<AgentConnectionArgs>
  project: pulumi.Input<string>
  files: pulumi.Input<Record<string, pulumi.Input<string>>>
}

/** Port mappings returned by the agent: service → container_port → host_port */
export type PortMappings = Record<string, Record<string, number>>

export class ComposeProject extends pulumi.dynamic.Resource {
  declare readonly project: pulumi.Output<string>
  declare readonly deployResult: pulumi.Output<unknown>
  /** Allocated host port mappings: service → container_port → host_port */
  declare readonly ports: pulumi.Output<PortMappings | undefined>

  constructor(name: string, args: ComposeProjectArgs, opts?: pulumi.CustomResourceOptions) {
    super(composeProjectProvider, name, { ...args, deployResult: undefined, ports: undefined }, opts)
  }
}

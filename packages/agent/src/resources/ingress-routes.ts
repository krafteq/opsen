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

interface IngressRoute {
  name: string
  domain: string
  path?: string
  upstream: string
  bind?: string
  tls?: {
    acme?: boolean
    cert?: string
    key?: string
  }
  headers?: Record<string, string>
  rateLimit?: number
  middleware?: string[]
}

interface IngressRoutesInputs {
  connection: AgentConnection
  app: string
  routes: IngressRoute[]
}

/** Transform TypeScript route to Go API format (camelCase → snake_case, domain → hosts). */
function toApiRoute(route: IngressRoute) {
  return {
    name: route.name,
    hosts: [route.domain],
    upstream: route.upstream,
    path_prefix: route.path,
    bind_address: route.bind,
    tls: route.tls,
    headers: route.headers,
    rate_limit_rps: route.rateLimit,
  }
}

const ingressRoutesProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: IngressRoutesInputs) {
    const resp = await agentRequest(inputs.connection, 'PUT', `/v1/ingress/apps/${inputs.app}/routes`, {
      routes: inputs.routes.map(toApiRoute),
    })
    checkResponse(resp, [200])
    return {
      id: inputs.app,
      outs: { ...inputs, updateResult: resp.body },
    }
  },

  async read(id, props: IngressRoutesInputs) {
    const resp = await agentRequest(props.connection, 'GET', `/v1/ingress/apps/${props.app}/routes`)
    if (resp.status === 404) {
      return { id: '', props: {} }
    }
    return { id, props: { ...props, statusResult: resp.body } }
  },

  async update(_id, _olds: IngressRoutesInputs, news: IngressRoutesInputs) {
    const resp = await agentRequest(news.connection, 'PUT', `/v1/ingress/apps/${news.app}/routes`, {
      routes: news.routes.map(toApiRoute),
    })
    checkResponse(resp, [200])
    return { outs: { ...news, updateResult: resp.body } }
  },

  async delete(_id, props: IngressRoutesInputs) {
    const resp = await agentRequest(props.connection, 'DELETE', `/v1/ingress/apps/${props.app}`)
    checkResponse(resp, [200, 404])
  },

  async diff(_id, olds: IngressRoutesInputs, news: IngressRoutesInputs) {
    const replaces: string[] = []
    if (olds.connection.endpoint !== news.connection.endpoint) {
      replaces.push('connection')
    }
    if (olds.app !== news.app) {
      replaces.push('app')
    }

    const changes = replaces.length > 0 || JSON.stringify(olds.routes) !== JSON.stringify(news.routes)

    return { changes, replaces }
  },
}

export interface IngressRouteArgs {
  name: pulumi.Input<string>
  domain: pulumi.Input<string>
  path?: pulumi.Input<string>
  upstream: pulumi.Input<string>
  /** Bind route to specific IP address (e.g. internal-only routes) */
  bind?: pulumi.Input<string>
  tls?: pulumi.Input<{
    acme?: pulumi.Input<boolean>
    cert?: pulumi.Input<string>
    key?: pulumi.Input<string>
  }>
  headers?: pulumi.Input<Record<string, pulumi.Input<string>>>
  rateLimit?: pulumi.Input<number>
  middleware?: pulumi.Input<pulumi.Input<string>[]>
}

export interface IngressRoutesArgs {
  connection: pulumi.Input<AgentConnectionArgs>
  /** App scope — each app manages its own set of routes independently within the same client. */
  app: pulumi.Input<string>
  routes: pulumi.Input<pulumi.Input<IngressRouteArgs>[]>
}

export class IngressRoutes extends pulumi.dynamic.Resource {
  declare readonly app: pulumi.Output<string>
  declare readonly routes: pulumi.Output<IngressRoute[]>
  declare readonly updateResult: pulumi.Output<unknown>

  constructor(name: string, args: IngressRoutesArgs, opts?: pulumi.CustomResourceOptions) {
    super(ingressRoutesProvider, name, { ...args, updateResult: undefined }, opts)
  }
}

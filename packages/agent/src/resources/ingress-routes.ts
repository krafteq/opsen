import * as pulumi from '@pulumi/pulumi'
import { type AgentConnection, agentRequest, checkResponse } from './client'

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
    const resp = await agentRequest(inputs.connection, 'PUT', '/v1/ingress/routes', {
      routes: inputs.routes.map(toApiRoute),
    })
    checkResponse(resp, [200])
    return {
      id: 'ingress-routes',
      outs: { ...inputs, updateResult: resp.body },
    }
  },

  async read(id, props: IngressRoutesInputs) {
    const resp = await agentRequest(props.connection, 'GET', '/v1/ingress/routes')
    if (resp.status === 404) {
      return { id: '', props: {} }
    }
    return { id, props: { ...props, statusResult: resp.body } }
  },

  async update(_id, _olds: IngressRoutesInputs, news: IngressRoutesInputs) {
    const resp = await agentRequest(news.connection, 'PUT', '/v1/ingress/routes', {
      routes: news.routes.map(toApiRoute),
    })
    checkResponse(resp, [200])
    return { outs: { ...news, updateResult: resp.body } }
  },

  async delete(_id, props: IngressRoutesInputs) {
    for (const route of props.routes) {
      const resp = await agentRequest(props.connection, 'DELETE', `/v1/ingress/routes/${route.name}`)
      checkResponse(resp, [200, 404])
    }
  },

  async diff(_id, olds: IngressRoutesInputs, news: IngressRoutesInputs) {
    const replaces: string[] = []
    if (olds.connection.endpoint !== news.connection.endpoint) {
      replaces.push('connection')
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
  connection: pulumi.Input<AgentConnection>
  routes: pulumi.Input<pulumi.Input<IngressRouteArgs>[]>
}

export class IngressRoutes extends pulumi.dynamic.Resource {
  declare readonly routes: pulumi.Output<IngressRoute[]>
  declare readonly updateResult: pulumi.Output<unknown>

  constructor(name: string, args: IngressRoutesArgs, opts?: pulumi.CustomResourceOptions) {
    super(ingressRoutesProvider, name, { ...args, updateResult: undefined }, opts)
  }
}

import * as pulumi from '@pulumi/pulumi'
import type { AgentConnectionArgs } from '../types'
import { type AgentConnection, agentRequest, checkResponse } from './client'

interface ComposeProjectInputs {
  connection: AgentConnection
  project: string
  files: Record<string, string>
}

/** Response from the agent's compose deploy endpoint. */
export interface ComposeDeployResult {
  status: string
  project: string
  services?: string[]
  policy_modifications?: string[]
  ports?: PortMappings
}

const composeProjectProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: ComposeProjectInputs) {
    const resp = await agentRequest(inputs.connection, 'PUT', `/v1/compose/projects/${inputs.project}`, {
      files: inputs.files,
    })
    checkResponse(resp, [200])
    const body = resp.body as ComposeDeployResult
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
    const body = resp.body as ComposeDeployResult
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
  declare readonly deployResult: pulumi.Output<ComposeDeployResult>
  /** Allocated host port mappings: service → container_port → host_port */
  declare readonly ports: pulumi.Output<PortMappings | undefined>

  constructor(name: string, args: ComposeProjectArgs, opts?: pulumi.CustomResourceOptions) {
    super(composeProjectProvider, name, { ...args, deployResult: undefined, ports: undefined }, opts)
  }
}

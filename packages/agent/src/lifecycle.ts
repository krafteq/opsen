import type { AgentConnection } from './types'
import { agentRequest, checkResponse } from './resources/client'

/** Response from a Compose project's explicit start or stop operation. */
export interface ComposeLifecycleResult {
  status: 'started' | 'stopped'
  project: string
  stopped: boolean
}

/** Response from an ingress app's explicit start or stop operation. */
export interface IngressLifecycleResult {
  status: 'started' | 'stopped'
  app: string
  stopped: boolean
}

async function transition<T>(connection: AgentConnection, path: string): Promise<T> {
  const response = await agentRequest(connection, 'POST', path)
  checkResponse(response, [200])
  return response.body as T
}

/** Stop containers while retaining project files, volumes, networks and port reservations. */
export function composeStop(connection: AgentConnection, project: string): Promise<ComposeLifecycleResult> {
  return transition(connection, `/v1/compose/projects/${encodeURIComponent(project)}/stop`)
}

/** Start a previously stopped project. Does not change ingress on other agents. */
export function composeStart(connection: AgentConnection, project: string): Promise<ComposeLifecycleResult> {
  return transition(connection, `/v1/compose/projects/${encodeURIComponent(project)}/start`)
}

/** Serve a stopped HTTP 503 response while retaining the app's ingress routes. */
export function ingressStop(connection: AgentConnection, app: string): Promise<IngressLifecycleResult> {
  return transition(connection, `/v1/ingress/apps/${encodeURIComponent(app)}/stop`)
}

/** Restore the app's retained ingress routes. Start its Compose project separately first. */
export function ingressStart(connection: AgentConnection, app: string): Promise<IngressLifecycleResult> {
  return transition(connection, `/v1/ingress/apps/${encodeURIComponent(app)}/start`)
}

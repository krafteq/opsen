import type { AgentConnection } from './types'
import { agentRequest, checkResponse } from './resources/client'

export const TEMPORARY_ACCESS_ROLES_CAPABILITY = 'temporary-access-roles-v1'

/** Immutable credentials for an externally scheduled database access lease. */
export interface DatabaseAccessRoleRequest {
  password: string
  access_mode: 'read' | 'readwrite'
  /** RFC3339 password deadline. Existing sessions require explicit revocation. */
  expires_at: string
  /** Existing schemas owned by the database owner. Defaults to public. */
  schemas?: string[]
}

/** Metadata only: neither password nor its request fingerprint is returned. */
export interface DatabaseAccessRoleStatus {
  role: string
  access_mode: 'read' | 'readwrite'
  schemas: string[]
  expires_at: string
  status: 'provisioning' | 'active' | 'revoking' | 'revoked'
}

function rolePath(database: string, role: string): string {
  return `/v1/db/databases/${encodeURIComponent(database)}/access-roles/${encodeURIComponent(role)}`
}

/** Refuse older agents before sending any temporary credentials. */
export async function requireDatabaseAccessRoles(connection: AgentConnection): Promise<void> {
  const response = await agentRequest(connection, 'GET', '/v1/db/capabilities')
  const body = response.body as { capabilities?: unknown } | null
  if (
    response.status !== 200 ||
    !Array.isArray(body?.capabilities) ||
    !body.capabilities.includes(TEMPORARY_ACCESS_ROLES_CAPABILITY)
  ) {
    throw new Error('Agent does not advertise temporary-access-roles-v1; upgrade the database agent first')
  }
}

/** Imperative API; never stores lease passwords in Pulumi resource state. */
export async function putDatabaseAccessRole(
  connection: AgentConnection,
  database: string,
  role: string,
  request: DatabaseAccessRoleRequest,
): Promise<DatabaseAccessRoleStatus> {
  await requireDatabaseAccessRoles(connection)
  const response = await agentRequest(connection, 'PUT', rolePath(database, role), request)
  checkResponse(response, [200])
  return response.body as DatabaseAccessRoleStatus
}

export async function getDatabaseAccessRole(
  connection: AgentConnection,
  database: string,
  role: string,
): Promise<DatabaseAccessRoleStatus | null> {
  await requireDatabaseAccessRoles(connection)
  const response = await agentRequest(connection, 'GET', rolePath(database, role))
  if (response.status === 404) return null
  checkResponse(response, [200])
  return response.body as DatabaseAccessRoleStatus
}

/** Disables login, terminates sessions and removes grants before dropping the role. */
export async function revokeDatabaseAccessRole(
  connection: AgentConnection,
  database: string,
  role: string,
): Promise<DatabaseAccessRoleStatus | null> {
  await requireDatabaseAccessRoles(connection)
  const response = await agentRequest(connection, 'DELETE', rolePath(database, role))
  if (response.status === 404) return null
  checkResponse(response, [200])
  return response.body as DatabaseAccessRoleStatus
}

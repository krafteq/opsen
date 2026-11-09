export { AgentInstaller } from './agent-installer'
export { createPlatformCA, issueAgentCert, issueClientCert } from './pki'
export type {
  AgentInstallerArgs,
  AgentConfig,
  AgentRoles,
  ComposeRoleConfig,
  IngressRoleConfig,
  GlobalHardening,
  DenyRules,
  ClientPolicy,
  ComposePolicy,
  IngressPolicy,
  DomainPolicy,
  TlsPolicy,
  UpstreamPolicy,
  ConnectionArgs,
  PlatformCAArgs,
  AgentCertArgs,
  ClientCertArgs,
  AgentConnection,
  AgentConnectionArgs,
  DbRoleConfig,
  DbPolicy,
  PerDatabaseLimits,
  RoleLimitBounds,
  DbPasswordPolicy,
  DbUsernamePolicy,
  DbExtensionPolicy,
  DbAccessPolicy,
  DatabaseOwnerArgs,
  DatabaseLimitsArgs,
} from './types'
export type { PlatformCA, IssuedCert } from './pki'

// Dynamic resources
export { ComposeProject } from './resources/compose-project'
export type { ComposeProjectArgs, PortMappings, ComposeDeployResult } from './resources/compose-project'
export { IngressRoutes } from './resources/ingress-routes'
export type { IngressRoutesArgs, IngressRouteArgs, IngressUpdateResult } from './resources/ingress-routes'
export { Database } from './resources/database'
export type { DatabaseArgs, DatabaseCreateResult } from './resources/database'
export { DatabaseRole } from './resources/database-role'
export type { DatabaseRoleArgs, DatabaseRoleCreateResult } from './resources/database-role'

// Imperative runtime lifecycle operations (independent of Pulumi desired resources).
export { composeStop, composeStart, ingressStop, ingressStart } from './lifecycle'
export type { ComposeLifecycleResult, IngressLifecycleResult } from './lifecycle'

export {
  TEMPORARY_ACCESS_ROLES_CAPABILITY,
  requireDatabaseAccessRoles,
  putDatabaseAccessRole,
  getDatabaseAccessRole,
  revokeDatabaseAccessRole,
} from './database-access'
export type { DatabaseAccessRoleRequest, DatabaseAccessRoleStatus } from './database-access'

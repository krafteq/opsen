import * as pulumi from '@pulumi/pulumi'
import * as command from '@pulumi/command'

// ── Connection ──────────────────────────────────────────

export type ConnectionArgs = command.types.input.remote.ConnectionArgs

// ── Agent Config ────────────────────────────────────────

export interface AgentConfig {
  listen: pulumi.Input<string>
  roles: pulumi.Input<AgentRoles>
  globalHardening?: pulumi.Input<GlobalHardening>
  deny?: pulumi.Input<DenyRules>
}

export interface AgentRoles {
  compose?: ComposeRoleConfig
  ingress?: IngressRoleConfig
  db?: DbRoleConfig
}

export interface ComposeRoleConfig {
  composeBinary?: string
  deploymentsDir?: string
  networkPrefix?: string
  /** Host port range for exposed container ports, e.g. "8000-8999" */
  portRange?: string
}

export interface IngressRoleConfig {
  driver: 'traefik' | 'caddy'
  configDir: string
  reloadCommand?: string
}

export interface DbRoleConfig {
  host: string
  port: number
  adminUser: string
  adminPasswordFile: string
  defaultEncoding?: string
  defaultLocale?: string
  sizeCheckInterval?: number
  sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full'
  dataDir?: string
}

export interface GlobalHardening {
  noNewPrivileges?: boolean
  capDropAll?: boolean
  readOnlyRootfs?: boolean
  defaultUser?: string
  defaultTmpfs?: TmpfsMount[]
  pidLimit?: number
}

export interface TmpfsMount {
  path: string
  options?: string
}

export interface DenyRules {
  privileged?: boolean
  networkModes?: string[]
  pidMode?: string
  ipcMode?: string
  hostPaths?: string[]
}

// ── Client Policy ───────────────────────────────────────

export interface ClientPolicy {
  name: pulumi.Input<string>
  compose?: pulumi.Input<ComposePolicy>
  ingress?: pulumi.Input<IngressPolicy>
  db?: pulumi.Input<DbPolicy>
}

// ComposePolicy governs Docker Compose project deployments.
// Resource limits are enforced across ALL projects for the client.
export interface ComposePolicy {
  // Cross-project resource limits
  maxContainers?: number
  maxMemoryMb?: number
  maxCpus?: number
  maxProjects?: number

  // Per-container defaults and limits
  perContainer?: PerContainerLimits

  // Per-project limits
  maxServices?: number
  allowBuild?: boolean
  allowEnvFile?: boolean

  // Policies
  network?: ComposeNetworkPolicy
  volumes?: ComposeVolumePolicy
  images?: ImagePolicy
  capabilities?: CapabilityPolicy
}

export interface PerContainerLimits {
  defaultMemoryMb?: number
  defaultCpus?: number
  maxMemoryMb?: number
  maxCpus?: number
  maxPids?: number
}

export interface ComposeNetworkPolicy {
  internetAccess?: boolean
  allowedEgress?: string[]
  ingressPortRange?: string
  ingressBindAddress?: string
}

export interface ComposeVolumePolicy {
  allowedHostPaths?: string[]
  maxVolumeCount?: number
}

export interface ImagePolicy {
  allowedRegistries?: string[]
  denyTags?: string[]
}

export interface CapabilityPolicy {
  allowed?: string[]
}

export interface IngressPolicy {
  maxRoutes?: number
  domains?: DomainPolicy
  tls?: TlsPolicy
  upstreams?: UpstreamPolicy
  headers?: HeaderPolicy
  rateLimiting?: RateLimitPolicy
  middleware?: MiddlewarePolicy
}

export interface DomainPolicy {
  allowed?: string[]
  denied?: string[]
}

export interface TlsPolicy {
  acmeChallenge?: 'http' | 'dns' | 'tls-alpn'
  acmeProvider?: 'letsencrypt' | 'zerossl' | 'custom'
  allowCustomCerts?: boolean
  minTlsVersion?: '1.2' | '1.3'
}

export interface UpstreamPolicy {
  allowedTargets?: string[]
  denyTargets?: string[]
}

export interface HeaderPolicy {
  forceHsts?: boolean
  forceXssProtection?: boolean
  allowCustomHeaders?: boolean
}

export interface RateLimitPolicy {
  enabled?: boolean
  defaultRps?: number
  maxRps?: number
}

export interface MiddlewarePolicy {
  allowed?: string[]
  denied?: string[]
}

// ── Database Policy ─────────────────────────────────────

export interface DbPolicy {
  maxDatabases?: number
  maxTotalSizeMb?: number
  maxTotalConnections?: number
  perDatabase?: PerDatabaseLimits
  roleLimits?: RoleLimitBounds
  password?: DbPasswordPolicy
  username?: DbUsernamePolicy
  extensions?: DbExtensionPolicy
  access?: DbAccessPolicy
}

export interface PerDatabaseLimits {
  maxSizeMb?: number
  maxConnectionLimit?: number
  maxRoles?: number
}

export interface RoleLimitBounds {
  maxWorkMem?: string
  maxTempFileLimit?: string
  minStatementTimeout?: string
  maxStatementTimeout?: string
}

export interface DbPasswordPolicy {
  minLength?: number
  requireUppercase?: boolean
  requireLowercase?: boolean
  requireDigit?: boolean
  requireSpecial?: boolean
  denyUsernameInPassword?: boolean
}

export interface DbUsernamePolicy {
  deniedNames?: string[]
  deniedPrefixes?: string[]
  requiredPrefix?: string
  maxLength?: number
}

export interface DbExtensionPolicy {
  allowed?: string[]
}

export interface DbAccessPolicy {
  allowedHosts?: string[]
}

// ── Agent Connection (for dynamic resources) ───────────

export interface AgentConnection {
  endpoint: string
  caCert: string
  clientCert: string
  clientKey: string
}

// ── Database Resource Args ─────────────────────────────

export interface DatabaseOwnerArgs {
  username: pulumi.Input<string>
  password: pulumi.Input<string>
}

export interface DatabaseLimitsArgs {
  maxSizeMb?: pulumi.Input<number>
  connectionLimit?: pulumi.Input<number>
  statementTimeout?: pulumi.Input<string>
  workMem?: pulumi.Input<string>
  tempFileLimit?: pulumi.Input<string>
}

// ── Installer Args ──────────────────────────────────────

export interface AgentInstallerArgs {
  connection: ConnectionArgs
  config: AgentConfig
  clients?: ClientPolicy[]
  tls: {
    ca: pulumi.Input<string>
    cert: pulumi.Input<string>
    key: pulumi.Input<string>
  }
}

// ── PKI Args ────────────────────────────────────────────

export interface PlatformCAArgs {
  commonName?: string
  organization?: string
  validityHours?: number
}

export interface AgentCertArgs {
  caCertPem: pulumi.Input<string>
  caPrivateKeyPem: pulumi.Input<string>
  commonName: pulumi.Input<string>
  ipAddresses?: pulumi.Input<pulumi.Input<string>[]>
  dnsNames?: pulumi.Input<pulumi.Input<string>[]>
  validityHours?: number
}

export interface ClientCertArgs {
  caCertPem: pulumi.Input<string>
  caPrivateKeyPem: pulumi.Input<string>
  clientName: pulumi.Input<string>
  validityHours?: number
}

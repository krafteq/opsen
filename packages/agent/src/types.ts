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
  compose?: pulumi.Input<ComposeRoleConfig>
  ingress?: pulumi.Input<IngressRoleConfig>
  db?: pulumi.Input<DbRoleConfig>
}

export interface ComposeRoleConfig {
  composeBinary?: pulumi.Input<string>
  deploymentsDir?: pulumi.Input<string>
  networkPrefix?: pulumi.Input<string>
  /** Host port range for exposed container ports, e.g. "8000-8999" */
  portRange?: pulumi.Input<string>
}

export interface IngressRoleConfig {
  driver: pulumi.Input<'traefik' | 'caddy'>
  configDir: pulumi.Input<string>
  reloadCommand?: pulumi.Input<string>
}

export interface DbRoleConfig {
  host: pulumi.Input<string>
  port: pulumi.Input<number>
  adminUser: pulumi.Input<string>
  adminPasswordFile: pulumi.Input<string>
  defaultEncoding?: pulumi.Input<string>
  defaultLocale?: pulumi.Input<string>
  sizeCheckInterval?: pulumi.Input<number>
  sslMode?: pulumi.Input<'disable' | 'require' | 'verify-ca' | 'verify-full'>
  dataDir?: pulumi.Input<string>
}

export interface GlobalHardening {
  noNewPrivileges?: pulumi.Input<boolean>
  capDropAll?: pulumi.Input<boolean>
  readOnlyRootfs?: pulumi.Input<boolean>
  defaultUser?: pulumi.Input<string>
  defaultTmpfs?: pulumi.Input<pulumi.Input<TmpfsMount>[]>
  pidLimit?: pulumi.Input<number>
}

export interface TmpfsMount {
  path: pulumi.Input<string>
  options?: pulumi.Input<string>
}

export interface DenyRules {
  privileged?: pulumi.Input<boolean>
  networkModes?: pulumi.Input<pulumi.Input<string>[]>
  pidMode?: pulumi.Input<string>
  ipcMode?: pulumi.Input<string>
  hostPaths?: pulumi.Input<pulumi.Input<string>[]>
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
  maxContainers?: pulumi.Input<number>
  maxMemoryMb?: pulumi.Input<number>
  maxCpus?: pulumi.Input<number>
  maxProjects?: pulumi.Input<number>

  // Per-container defaults and limits
  perContainer?: pulumi.Input<PerContainerLimits>

  // Per-project limits
  maxServices?: pulumi.Input<number>
  allowBuild?: pulumi.Input<boolean>
  allowEnvFile?: pulumi.Input<boolean>

  // Policies
  network?: pulumi.Input<ComposeNetworkPolicy>
  volumes?: pulumi.Input<ComposeVolumePolicy>
  images?: pulumi.Input<ImagePolicy>
  capabilities?: pulumi.Input<CapabilityPolicy>
}

export interface PerContainerLimits {
  defaultMemoryMb?: pulumi.Input<number>
  defaultCpus?: pulumi.Input<number>
  maxMemoryMb?: pulumi.Input<number>
  maxCpus?: pulumi.Input<number>
  maxPids?: pulumi.Input<number>
}

export interface ComposeNetworkPolicy {
  internetAccess?: pulumi.Input<boolean>
  allowedEgress?: pulumi.Input<pulumi.Input<string>[]>
  ingressPortRange?: pulumi.Input<string>
  ingressBindAddress?: pulumi.Input<string>
}

export interface ComposeVolumePolicy {
  allowedHostPaths?: pulumi.Input<pulumi.Input<string>[]>
  maxVolumeCount?: pulumi.Input<number>
}

export interface ImagePolicy {
  allowedRegistries?: pulumi.Input<pulumi.Input<string>[]>
  denyTags?: pulumi.Input<pulumi.Input<string>[]>
}

export interface CapabilityPolicy {
  allowed?: pulumi.Input<pulumi.Input<string>[]>
}

export interface IngressPolicy {
  maxRoutes?: pulumi.Input<number>
  domains?: pulumi.Input<DomainPolicy>
  tls?: pulumi.Input<TlsPolicy>
  upstreams?: pulumi.Input<UpstreamPolicy>
  headers?: pulumi.Input<HeaderPolicy>
  rateLimiting?: pulumi.Input<RateLimitPolicy>
  middleware?: pulumi.Input<MiddlewarePolicy>
}

export interface DomainPolicy {
  allowed?: pulumi.Input<pulumi.Input<string>[]>
  denied?: pulumi.Input<pulumi.Input<string>[]>
}

export interface TlsPolicy {
  acmeChallenge?: pulumi.Input<'http' | 'dns' | 'tls-alpn'>
  acmeProvider?: pulumi.Input<'letsencrypt' | 'zerossl' | 'custom'>
  allowCustomCerts?: pulumi.Input<boolean>
  minTlsVersion?: pulumi.Input<'1.2' | '1.3'>
}

export interface UpstreamPolicy {
  allowedTargets?: pulumi.Input<pulumi.Input<string>[]>
  denyTargets?: pulumi.Input<pulumi.Input<string>[]>
}

export interface HeaderPolicy {
  forceHsts?: pulumi.Input<boolean>
  forceXssProtection?: pulumi.Input<boolean>
  allowCustomHeaders?: pulumi.Input<boolean>
}

export interface RateLimitPolicy {
  enabled?: pulumi.Input<boolean>
  defaultRps?: pulumi.Input<number>
  maxRps?: pulumi.Input<number>
}

export interface MiddlewarePolicy {
  allowed?: pulumi.Input<pulumi.Input<string>[]>
  denied?: pulumi.Input<pulumi.Input<string>[]>
}

// ── Database Policy ─────────────────────────────────────

export interface DbPolicy {
  maxDatabases?: pulumi.Input<number>
  maxTotalSizeMb?: pulumi.Input<number>
  maxTotalConnections?: pulumi.Input<number>
  perDatabase?: pulumi.Input<PerDatabaseLimits>
  roleLimits?: pulumi.Input<RoleLimitBounds>
  password?: pulumi.Input<DbPasswordPolicy>
  username?: pulumi.Input<DbUsernamePolicy>
  extensions?: pulumi.Input<DbExtensionPolicy>
  access?: pulumi.Input<DbAccessPolicy>
}

export interface PerDatabaseLimits {
  maxSizeMb?: pulumi.Input<number>
  maxConnectionLimit?: pulumi.Input<number>
  maxRoles?: pulumi.Input<number>
}

export interface RoleLimitBounds {
  maxWorkMem?: pulumi.Input<string>
  maxTempFileLimit?: pulumi.Input<string>
  minStatementTimeout?: pulumi.Input<string>
  maxStatementTimeout?: pulumi.Input<string>
}

export interface DbPasswordPolicy {
  minLength?: pulumi.Input<number>
  requireUppercase?: pulumi.Input<boolean>
  requireLowercase?: pulumi.Input<boolean>
  requireDigit?: pulumi.Input<boolean>
  requireSpecial?: pulumi.Input<boolean>
  denyUsernameInPassword?: pulumi.Input<boolean>
}

export interface DbUsernamePolicy {
  deniedNames?: pulumi.Input<pulumi.Input<string>[]>
  deniedPrefixes?: pulumi.Input<pulumi.Input<string>[]>
  requiredPrefix?: pulumi.Input<string>
  maxLength?: pulumi.Input<number>
}

export interface DbExtensionPolicy {
  allowed?: pulumi.Input<pulumi.Input<string>[]>
}

export interface DbAccessPolicy {
  allowedHosts?: pulumi.Input<pulumi.Input<string>[]>
}

// ── Agent Connection (for dynamic resources) ───────────

/** Plain connection type — used by provider internals after Input resolution. */
export interface AgentConnection {
  endpoint: string
  caCert: string
  clientCert: string
  clientKey: string
}

/** Input-wrapped connection — allows consumers to pass Outputs for individual fields. */
export interface AgentConnectionArgs {
  endpoint: pulumi.Input<string>
  caCert: pulumi.Input<string>
  clientCert: pulumi.Input<string>
  clientKey: pulumi.Input<string>
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
  config: pulumi.Input<AgentConfig>
  clients?: pulumi.Input<ClientPolicy>[]
  tls: pulumi.Input<{
    ca: pulumi.Input<string>
    cert: pulumi.Input<string>
    key: pulumi.Input<string>
  }>
}

// ── PKI Args ────────────────────────────────────────────

export interface PlatformCAArgs {
  commonName?: pulumi.Input<string>
  organization?: pulumi.Input<string>
  validityHours?: pulumi.Input<number>
}

export interface AgentCertArgs {
  caCertPem: pulumi.Input<string>
  caPrivateKeyPem: pulumi.Input<string>
  commonName: pulumi.Input<string>
  ipAddresses?: pulumi.Input<pulumi.Input<string>[]>
  dnsNames?: pulumi.Input<pulumi.Input<string>[]>
  validityHours?: pulumi.Input<number>
}

export interface ClientCertArgs {
  caCertPem: pulumi.Input<string>
  caPrivateKeyPem: pulumi.Input<string>
  clientName: pulumi.Input<string>
  validityHours?: pulumi.Input<number>
}

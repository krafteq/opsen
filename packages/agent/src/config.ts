import * as pulumi from '@pulumi/pulumi'
import type { AgentConfig, ClientPolicy } from './types.js'

export function serializeAgentConfig(config: pulumi.Unwrap<AgentConfig>): string {
  const doc: Record<string, unknown> = {
    listen: config.listen,
    tls: {
      cert: '/etc/opsen-agent/server.pem',
      key: '/etc/opsen-agent/server-key.pem',
      ca: '/etc/opsen-agent/ca.pem',
      min_version: '1.3',
    },
    clients_dir: '/etc/opsen-agent/clients/',
    logging: {
      file: '/var/log/opsen-agent/agent.log',
      audit_file: '/var/log/opsen-agent/audit.log',
      level: 'info',
    },
    reload: {
      watch_clients_dir: true,
    },
  }

  const roles: Record<string, unknown> = {}

  if (config.roles?.compose) {
    const c = config.roles.compose
    roles.compose = {
      compose_binary: c.composeBinary ?? 'docker compose',
      deployments_dir: c.deploymentsDir ?? '/var/lib/opsen-agent/deployments/',
      network_prefix: c.networkPrefix ?? 'opsen',
    }
  }

  if (config.roles?.ingress) {
    const i = config.roles.ingress
    roles.ingress = {
      driver: i.driver,
      config_dir: i.configDir,
      ...(i.reloadCommand ? { reload_command: i.reloadCommand } : {}),
    }
  }

  if (config.roles?.db) {
    const d = config.roles.db
    roles.db = {
      host: d.host,
      port: d.port,
      admin_user: d.adminUser,
      admin_password_file: d.adminPasswordFile,
      default_encoding: d.defaultEncoding ?? 'UTF8',
      default_locale: d.defaultLocale ?? 'en_US.UTF-8',
      size_check_interval: d.sizeCheckInterval ?? 60,
      ssl_mode: d.sslMode ?? 'require',
      data_dir: d.dataDir ?? '/var/lib/opsen-agent/db/',
    }
  }

  doc.roles = roles

  const hardening = config.globalHardening
  doc.global_hardening = {
    no_new_privileges: hardening?.noNewPrivileges ?? true,
    cap_drop_all: hardening?.capDropAll ?? true,
    read_only_rootfs: hardening?.readOnlyRootfs ?? true,
    default_user: hardening?.defaultUser ?? '1000:1000',
    default_tmpfs: hardening?.defaultTmpfs ?? [{ path: '/tmp', options: 'noexec,nosuid,size=64m' }],
    pid_limit: hardening?.pidLimit ?? 100,
  }

  const deny = config.deny
  doc.deny = {
    privileged: deny?.privileged ?? true,
    network_modes: deny?.networkModes ?? ['host'],
    pid_mode: deny?.pidMode ?? 'host',
    ipc_mode: deny?.ipcMode ?? 'host',
    host_paths: deny?.hostPaths ?? ['/', '/etc', '/var/run/docker.sock', '/proc', '/sys', '/dev'],
  }

  return toYaml(doc)
}

export function serializeClientPolicy(client: pulumi.Unwrap<ClientPolicy>): string {
  const doc: Record<string, unknown> = { client: client.name }

  if (client.compose) {
    const c = client.compose
    const compose: Record<string, unknown> = {}
    if (c.maxContainers != null) compose.max_containers = c.maxContainers
    if (c.maxMemoryMb != null) compose.max_memory_mb = c.maxMemoryMb
    if (c.maxCpus != null) compose.max_cpus = c.maxCpus
    if (c.maxProjects != null) compose.max_projects = c.maxProjects
    if (c.maxServices != null) compose.max_services = c.maxServices
    if (c.allowBuild != null) compose.allow_build = c.allowBuild
    if (c.allowEnvFile != null) compose.allow_env_file = c.allowEnvFile

    if (c.perContainer) compose.per_container = toSnakeKeys(c.perContainer)
    if (c.network) compose.network = toSnakeKeys(c.network)
    if (c.volumes) compose.volumes = toSnakeKeys(c.volumes)
    if (c.images) compose.images = toSnakeKeys(c.images)
    if (c.capabilities) compose.capabilities = toSnakeKeys(c.capabilities)

    doc.compose = compose
  }

  if (client.ingress) {
    const i = client.ingress
    const ingress: Record<string, unknown> = {}
    if (i.maxRoutes != null) ingress.max_routes = i.maxRoutes
    if (i.domains) ingress.domains = toSnakeKeys(i.domains)
    if (i.tls) ingress.tls = toSnakeKeys(i.tls)
    if (i.upstreams) ingress.upstreams = toSnakeKeys(i.upstreams)
    if (i.headers) ingress.headers = toSnakeKeys(i.headers)
    if (i.rateLimiting) ingress.rate_limiting = toSnakeKeys(i.rateLimiting)
    if (i.middleware) ingress.middleware = toSnakeKeys(i.middleware)
    doc.ingress = ingress
  }

  if (client.db) {
    const d = client.db
    const db: Record<string, unknown> = {}
    if (d.maxDatabases != null) db.max_databases = d.maxDatabases
    if (d.maxTotalSizeMb != null) db.max_total_size_mb = d.maxTotalSizeMb
    if (d.maxTotalConnections != null) db.max_total_connections = d.maxTotalConnections
    if (d.perDatabase) db.per_database = toSnakeKeys(d.perDatabase)
    if (d.roleLimits) db.role_limits = toSnakeKeys(d.roleLimits)
    if (d.password) db.password = toSnakeKeys(d.password)
    if (d.username) db.username = toSnakeKeys(d.username)
    if (d.extensions) db.extensions = toSnakeKeys(d.extensions)
    if (d.access) db.access = toSnakeKeys(d.access)
    doc.db = db
  }

  return toYaml(doc)
}

function toSnakeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase()
    result[snakeKey] = value
  }
  return result
}

function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)

  if (obj === null || obj === undefined) return `${pad}~`
  if (typeof obj === 'string') return obj.includes(':') || obj.includes('#') ? `"${obj}"` : obj
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return obj
      .map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const inner = toYamlObject(item as Record<string, unknown>, indent + 1)
          const lines = inner.split('\n')
          return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).join('\n')}`
        }
        return `${pad}- ${toYaml(item, 0)}`
      })
      .join('\n')
  }

  if (typeof obj === 'object') {
    return toYamlObject(obj as Record<string, unknown>, indent)
  }

  return String(obj)
}

function toYamlObject(obj: Record<string, unknown>, indent: number): string {
  const pad = '  '.repeat(indent)
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  return entries
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        return `${pad}${key}:\n${toYaml(value, indent + 1)}`
      }
      return `${pad}${key}: ${toYaml(value, 0)}`
    })
    .join('\n')
}

# opsen-agent Specification

## Overview

`opsen-agent` is a lightweight Go binary that runs on Linux VMs as a systemd service. It provides a secure, policy-enforcing API for deploying Docker Compose projects, configuring reverse proxy ingress rules, and provisioning PostgreSQL databases — replacing direct SSH access to infrastructure.

The agent is deployed via the `@opsen/agent` npm package, which provides Pulumi ComponentResources for building the binary locally in Docker, uploading it to remote VMs, and managing its lifecycle as a systemd service.

## Goals

- **No SSH for deployments** — all operations go through the agent's mTLS-authenticated API
- **Per-client policy enforcement** — resource limits, security hardening, and access controls are defined per client and enforced at the agent level
- **Multi-role** — the same binary supports compose (Docker Compose deployments), ingress (reverse proxy configuration), and db (PostgreSQL provisioning) roles, enabled per-VM based on configuration
- **Minimal footprint** — static Go binary (~7MB), no runtime dependencies beyond Docker (for compose role) or PostgreSQL client access (for db role)

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│  Pulumi Pipeline (confidential)                     │
│  ┌──────────────┐   ┌──────────────────────────┐    │
│  │ @pulumi/tls  │   │ @opsen/agent             │    │
│  │ Platform CA  │   │ AgentInstaller           │    │
│  │ Client certs │   │ (ComponentResource)      │    │
│  └──────┬───────┘   └──────────┬───────────────┘    │
└─────────┼──────────────────────┼────────────────────┘
          │                      │
          │  mTLS certs          │  binary + config + systemd
          ▼                      ▼
┌─────────────────────────────────────────────────────┐
│  Worker VM                                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  opsen-agent (systemd)                        │  │
│  │  ├─ /etc/opsen-agent/agent.yaml               │  │
│  │  ├─ /etc/opsen-agent/clients/*.yaml           │  │
│  │  ├─ /etc/opsen-agent/{ca,server,key}.pem      │  │
│  │  └─ /var/lib/opsen-agent/deployments/         │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Authentication

### mTLS (Mutual TLS)

All API communication uses mutual TLS. The platform Pulumi pipeline creates a private CA and issues certificates:

- **Platform CA** — ECDSA P384 self-signed root (10-year validity by default)
- **Server cert** — ECDSA P256, signed by CA, with IP/DNS SANs for the VM, `server_auth` key usage (1-year validity)
- **Client cert** — ECDSA P256, signed by CA, CN=client name, OU=project, `client_auth` key usage (1-year validity)

The agent requires `RequireAndVerifyClientCert`. TLS 1.3 is the default minimum version (1.2 configurable). The client's CN is extracted from the peer certificate and used to look up the corresponding policy file.

### Client Identity Flow

```text
1. Client connects with mTLS cert (CN = "myproject")
2. Agent middleware extracts CN from r.TLS.PeerCertificates[0].Subject.CommonName
3. ClientStore.Get("myproject") loads the policy from /etc/opsen-agent/clients/myproject.yaml
4. Policy is injected into request context via identity.WithClient()
5. Role handler retrieves policy via identity.ClientFromContext()
```

Unknown clients (valid cert but no policy file) receive `403 Forbidden`.

## Roles

The agent supports three roles, independently enabled per-VM via configuration. A single VM can run multiple roles.

### Compose Role

Manages Docker Compose project deployments with security hardening and resource tracking.

#### API Endpoints

| Method   | Path                             | Description                      |
| -------- | -------------------------------- | -------------------------------- |
| `PUT`    | `/v1/compose/projects/{project}` | Create or replace a project      |
| `DELETE` | `/v1/compose/projects/{project}` | Destroy a project                |
| `GET`    | `/v1/compose/projects/{project}` | Get project status               |
| `GET`    | `/v1/compose/projects`           | List all projects for the client |

#### Deploy Request (`PUT /v1/compose/projects/my-app`)

```json
{
  "files": {
    "compose.yml": "services:\n  web:\n    image: nginx:1.25\n    ports:\n      - '8080:80'\n",
    "config/nginx.conf": "server { listen 80; ... }",
    ".env": "DB_HOST=10.0.0.5"
  }
}
```

The `files` field is a map of `relative path -> content`. The agent looks for a compose file by checking these names in order: `compose.yml`, `compose.yaml`, `docker-compose.yml`, `docker-compose.yaml`.

#### Deploy Pipeline

```text
1. Extract project name from URL path, parse request body (files map)
2. Find compose file in the files map
3. Parse compose YAML into structured representation
4. Validate against deny-list rules (global) and client policy
5. Calculate resource usage (containers, memory, CPU)
6. Check cross-project resource budget via ResourceTracker
7. Apply hardening (security_opt, cap_drop, read_only, tmpfs, pids_limit, user, logging, network isolation)
8. Write ALL files to project directory (sanitized paths, no path traversal)
9. Write hardened compose file (replaces original)
10. Run: docker compose -p opsen-{client}-{project} -f {path} up -d --remove-orphans
11. Update ResourceTracker with new resource usage
12. Return deploy response with services list and policy modifications
```

#### Deploy Response

```json
{
  "status": "deployed",
  "project": "opsen-myproject-my-app",
  "services": ["web", "worker"],
  "policy_modifications": [
    "web: injected no-new-privileges",
    "web: set cap_drop ALL",
    "web: set read_only true",
    "web: set user 1000:1000",
    "web: set pids_limit 100"
  ]
}
```

#### Destroy

Runs `docker compose down --volumes --remove-orphans`, removes the project directory, and removes the project from the resource tracker.

#### Status

Single project: returns container info (via `docker compose ps --format json`) and tracked resource usage.
All projects: returns list of projects with per-project resources and aggregated totals.

#### Docker Compose Project Naming

All projects are namespaced: `opsen-{client}-{project}`. This prevents collisions between clients and makes audit/cleanup straightforward.

#### File Path Security

- Paths are cleaned via `filepath.Clean()`
- Paths starting with `..` or absolute paths are rejected
- Subdirectories are created as needed (e.g., `config/nginx.conf` creates `config/`)

### Ingress Role

Manages reverse proxy configuration files (Traefik or Caddy) via a driver abstraction.

#### API Endpoints

| Method   | Path                        | Description                       |
| -------- | --------------------------- | --------------------------------- |
| `PUT`    | `/v1/ingress/routes`        | Replace all routes for the client |
| `DELETE` | `/v1/ingress/routes/{name}` | Delete a route                    |
| `GET`    | `/v1/ingress/routes`        | List routes for the client        |

#### Route Definition

```json
{
  "routes": [
    {
      "name": "api",
      "hosts": ["api.example.com"],
      "upstream": "10.0.0.5:3000",
      "path_prefix": "/v1",
      "tls": { "acme": true },
      "headers": { "X-Custom": "value" },
      "cors": {
        "origins": ["https://app.example.com"],
        "methods": ["GET", "POST"]
      },
      "rate_limit_rps": 100
    }
  ]
}
```

#### Route Processing Pipeline

```text
1. Validate routes against client ingress policy
   - Domain allow/deny matching (specificity-based, deny wins on tie)
   - Upstream allow/deny matching (supports CIDR, port ranges)
   - Rate limit max check
   - Route count limit
2. Inject platform defaults
   - Default rate limit if policy defines one
   - Security headers (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
3. Generate config via driver (Traefik YAML or Caddyfile)
4. Write config to disk
5. Reload (Traefik: no-op file watch; Caddy: configurable reload command)
```

#### Drivers

**Driver interface:**

```go
type Driver interface {
    WriteConfig(clientName string, routes []Route) error
    DeleteRoute(clientName string, routeName string) error
    ListRoutes(clientName string) ([]string, error)
    Reload() error
}
```

**Traefik driver:**

- Generates dynamic YAML config files at `{configDir}/{client}.yml`
- Creates routers, services, and middlewares with client-prefixed names
- Security headers middleware shared per client
- Per-route rate limit and CORS middlewares
- Reload is no-op (Traefik watches the file provider directory)

**Caddy driver:**

- Generates Caddyfile blocks at `{configDir}/{client}.conf`
- Supports path-based routing via `handle_path`
- Reload executes configured command (e.g., `caddy reload`)

### Database Role

Provisions and manages PostgreSQL databases with per-client resource limits, password policies, and username restrictions. The agent connects to a PostgreSQL server (typically on the same VM or a nearby DB VM) with a management role that has `CREATEROLE CREATEDB` privileges.

#### Architecture

The db role does **not** install or manage PostgreSQL itself. It assumes a running PostgreSQL server and connects to it as a privileged management user. The agent handles:

- Database and role lifecycle (create, drop)
- Resource limit enforcement (connection limits, GUC parameters)
- Disk size monitoring with quota enforcement (revoke connect when exceeded)
- Password and username policy validation
- Extension allowlisting

#### API Endpoints

| Method   | Path                                   | Description                               |
| -------- | -------------------------------------- | ----------------------------------------- |
| `PUT`    | `/v1/db/databases/{name}`              | Create or replace a database + owner role |
| `PATCH`  | `/v1/db/databases/{name}`              | Update limits                             |
| `DELETE` | `/v1/db/databases/{name}`              | Drop database + all roles                 |
| `GET`    | `/v1/db/databases/{name}`              | Get database status (size, connections)   |
| `GET`    | `/v1/db/databases`                     | List all databases for the client         |
| `PUT`    | `/v1/db/databases/{name}/roles/{role}` | Create or replace a role                  |
| `DELETE` | `/v1/db/databases/{name}/roles/{role}` | Drop role                                 |

#### Create Database Request (`PUT /v1/db/databases/myapp`)

```json
{
  "owner": {
    "username": "myapp_user",
    "password": "SecureP@ss123!"
  },
  "limits": {
    "max_size_mb": 1024,
    "connection_limit": 20,
    "statement_timeout": "30s",
    "work_mem": "64MB",
    "temp_file_limit": "256MB",
    "idle_in_transaction_timeout": "60s",
    "maintenance_work_mem": "100MB"
  },
  "extensions": ["uuid-ossp", "pgcrypto"]
}
```

#### Create Database Pipeline

```text
1. Extract database name from URL path, validate against client db policy
   - Database count limit
   - Database name format (lowercase, alphanumeric + underscore, starts with letter)
   - Username policy (denied names, denied prefixes, required prefix, max length)
   - Password policy (min length, complexity, deny username in password, common passwords)
   - Resource limits within policy bounds
   - Extension allowlist
   - Total size budget check
2. Create PostgreSQL role with SCRAM-SHA-256 password
   - Role name: opsen_{client}_{dbname}_{username}
   - NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
   - Connection limit from request
3. Set role GUCs via ALTER ROLE ... SET
   - statement_timeout, work_mem, temp_file_limit, idle_in_transaction_session_timeout, maintenance_work_mem
4. Create database owned by the new role
   - Database name: opsen_{client}_{dbname}
   - Connection limit from request
   - REVOKE CONNECT FROM PUBLIC (only owner + explicitly granted roles)
5. Create requested extensions in the database
6. Record in resource tracker (db-state.json)
7. Return connection details (host, port, database, owner)
```

#### Create Database Response

```json
{
  "status": "created",
  "database": "opsen_myproject_myapp",
  "owner": "opsen_myproject_myapp_myapp_user",
  "host": "127.0.0.1",
  "port": 5432
}
```

#### Drop Database

1. Terminates all active connections to the database (`pg_terminate_backend`)
2. Drops the database (`DROP DATABASE IF EXISTS`)
3. Drops all additional roles, then the owner role
4. Removes from resource tracker

#### Database Status

Single database: returns current size (via `pg_database_size()`), active connections, connection limit, max size, extensions, and quota status.

All databases: returns list with per-database size and quota status, plus total size across all databases.

#### Update Database

Updates connection limits (via `ALTER DATABASE ... CONNECTION LIMIT`) and role GUCs (via `ALTER ROLE ... SET`). Validates updated limits against policy bounds.

#### Additional Roles

Create additional roles (e.g., read-only users) within a database. Each role gets `CONNECT` on the database. Read-only roles get `SELECT` grants on all tables and default privileges for future tables.

Additional role names follow the same naming pattern: `opsen_{client}_{dbname}_{username}`.

#### Database & Role Naming

All identifiers are namespaced to prevent collisions:

- Database: `opsen_{client}_{name}`
- Owner role: `opsen_{client}_{name}_{username}`
- Additional role: `opsen_{client}_{name}_{username}`

All names are validated as safe SQL identifiers (lowercase alphanumeric + underscore, max 63 chars, starts with letter). Identifiers are always quoted in SQL to prevent injection.

#### Disk Size Monitoring

PostgreSQL has no native per-database disk quota. The agent runs a background monitor:

```text
Every {size_check_interval} seconds (default 60):
  For each tracked database:
    1. Query pg_database_size()
    2. If size > max_size_mb AND not already quota_exceeded:
       - REVOKE CONNECT ON DATABASE FROM owner (blocks new connections)
       - Mark as quota_exceeded in tracker
       - Log audit event
    3. If size <= max_size_mb AND quota_exceeded:
       - GRANT CONNECT ON DATABASE TO owner (restore access)
       - Clear quota_exceeded flag
       - Log audit event
  For each client:
    4. Sum all database sizes, warn if > max_total_size_mb
```

This is a **soft quota** — existing connections continue to work, but new connections are blocked until the database is cleaned up below the limit.

#### PostgreSQL Management Role

The agent connects with a role that has `CREATEROLE CREATEDB` privileges but is **not** a superuser:

```sql
CREATE ROLE opsen_manager WITH CREATEROLE CREATEDB LOGIN PASSWORD 'stored-in-file';
```

This role can:

- Create and drop roles (non-superuser)
- Create and drop databases
- Set role parameters
- Grant/revoke privileges
- Query `pg_database_size()`, `pg_stat_activity`

It cannot:

- Modify superuser roles
- Change `postgresql.conf`
- Create untrusted extensions
- Use `BYPASSRLS`

### Health Endpoint

| Method | Path         | Description                     |
| ------ | ------------ | ------------------------------- |
| `GET`  | `/v1/health` | Health check (no auth required) |

Returns `{"status":"ok"}`. No mTLS client certificate required.

## Policy Enforcement

### Global Deny Rules

Applied to all clients, configured in `agent.yaml`:

| Rule            | Default                                                          | Effect                                     |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `privileged`    | `true` (deny)                                                    | Blocks `privileged: true` on any container |
| `network_modes` | `["host"]`                                                       | Blocks `network_mode: host`                |
| `pid_mode`      | `"host"`                                                         | Blocks `pid: host`                         |
| `ipc_mode`      | `"host"`                                                         | Blocks `ipc: host`                         |
| `host_paths`    | `["/", "/etc", "/var/run/docker.sock", "/proc", "/sys", "/dev"]` | Blocks bind mounts to sensitive host paths |

`userns_mode: host` is always denied (hardcoded).

### Global Hardening Injection

Applied to every container after validation, configured in `agent.yaml`:

| Hardening           | Default                                               | What it does                                                                     |
| ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `no_new_privileges` | `true`                                                | Injects `security_opt: [no-new-privileges:true]` — prevents SUID/SGID escalation |
| `cap_drop_all`      | `true`                                                | Sets `cap_drop: [ALL]` — removes all Linux capabilities                          |
| `read_only_rootfs`  | `true`                                                | Sets `read_only: true` — prevents filesystem writes outside volumes/tmpfs        |
| `default_user`      | `"1000:1000"`                                         | Sets `user: 1000:1000` if not explicitly set — prevents running as root          |
| `default_tmpfs`     | `[{path: "/tmp", options: "noexec,nosuid,size=64m"}]` | Mounts writable tmpfs with restricted options                                    |
| `pid_limit`         | `100`                                                 | Sets `pids_limit` — prevents fork bombs                                          |

Additional forced modifications:

- **Logging**: forced to `json-file` driver with `max-size: 10m`, `max-file: 3` (prevents log bomb DoS)
- **Network isolation**: all service-defined networks are replaced with a single project network named `opsen-{client}-internal`, set to `--internal` (no internet) unless client policy explicitly allows `internet_access`
- **Stripped fields**: `network_mode`, `pid`, `ipc`, `userns_mode` are blanked on all services

### Per-Client Compose Policy

Each client policy file defines limits enforced during deployment:

```yaml
client: myproject
compose:
  # Cross-project resource limits (tracked across ALL projects)
  max_containers: 20
  max_memory_mb: 4096
  max_cpus: 4.0
  max_projects: 5

  # Per-container limits
  per_container:
    default_memory_mb: 256
    default_cpus: 0.5
    max_memory_mb: 1024
    max_cpus: 2.0
    max_pids: 200

  # Per-project limits
  max_services: 10
  allow_build: false
  allow_env_file: false

  # Network policy
  network:
    internet_access: false
    allowed_egress: []
    ingress_port_range: '8000-8999'
    ingress_bind_address: '0.0.0.0'

  # Volume policy
  volumes:
    allowed_host_paths: ['/data/myproject']
    max_volume_count: 5

  # Image policy
  images:
    allowed_registries: ['docker.io/library', 'ghcr.io/myorg']
    deny_tags: ['latest']

  # Capability policy
  capabilities:
    allowed: ['NET_BIND_SERVICE']
```

### Per-Client Ingress Policy

```yaml
client: myproject
ingress:
  max_routes: 10

  domains:
    allowed: ['*.example.com', 'api.myapp.io']
    denied: ['admin.*']

  tls:
    acme_challenge: http
    acme_provider: letsencrypt
    allow_custom_certs: false
    min_tls_version: '1.3'

  upstreams:
    allowed_targets: ['10.0.0.5:3000-3099', '10.0.0.0/24:*']
    deny_targets: ['10.0.0.1:*']

  headers:
    force_hsts: true
    force_xss_protection: true
    allow_custom_headers: true

  rate_limiting:
    enabled: true
    default_rps: 50
    max_rps: 1000

  middleware:
    allowed: []
    denied: []
```

### Per-Client Database Policy

```yaml
client: myproject
db:
  # Cross-database limits
  max_databases: 5
  max_total_size_mb: 10240
  max_total_connections: 100

  # Per-database limits
  per_database:
    max_size_mb: 2048
    max_connection_limit: 50
    max_roles: 5

  # Role settings bounds (maximums the client can request)
  role_limits:
    max_work_mem: '128MB'
    max_temp_file_limit: '512MB'
    min_statement_timeout: '5s'
    max_statement_timeout: '300s'

  # Password policy
  password:
    min_length: 12
    require_uppercase: true
    require_lowercase: true
    require_digit: true
    require_special: true
    deny_username_in_password: true

  # Username policy
  username:
    denied_names: ['postgres', 'admin', 'root', 'replication']
    denied_prefixes: ['pg_']
    required_prefix: ''
    max_length: 63

  # Extension allowlist
  extensions:
    allowed: ['uuid-ossp', 'pgcrypto', 'pg_trgm', 'btree_gin']

  # Network access (for documentation/future pg_hba integration)
  access:
    allowed_hosts: ['10.0.0.0/24']
```

#### Password Validation

Passwords are validated by the agent before being sent to PostgreSQL:

| Check                 | Configurable                | Description                             |
| --------------------- | --------------------------- | --------------------------------------- |
| Minimum length        | `min_length`                | Default: 0 (no minimum)                 |
| Uppercase required    | `require_uppercase`         | At least one uppercase letter           |
| Lowercase required    | `require_lowercase`         | At least one lowercase letter           |
| Digit required        | `require_digit`             | At least one digit                      |
| Special char required | `require_special`           | At least one non-alphanumeric character |
| Username in password  | `deny_username_in_password` | Case-insensitive substring check        |
| Common passwords      | Always on                   | Rejects ~15 most common passwords       |

All passwords are stored using SCRAM-SHA-256 encryption (enforced via `SET password_encryption = 'scram-sha-256'` before role creation).

#### Username Validation

| Check           | Configurable      | Description                                             |
| --------------- | ----------------- | ------------------------------------------------------- |
| Denied names    | `denied_names`    | Exact match deny list (e.g., `postgres`, `root`)        |
| Denied prefixes | `denied_prefixes` | Prefix deny list (e.g., `pg_`)                          |
| Required prefix | `required_prefix` | Must start with this prefix (e.g., `myproject_`)        |
| Max length      | `max_length`      | Maximum characters (Postgres limit: 63)                 |
| Format          | Always on         | Lowercase alphanumeric + underscore, starts with letter |

### Domain Matching

Domain matching uses specificity-based scoring:

- **Exact match** scores 1000 (highest)
- **Wildcard prefix** `*.example.com` scores by pattern depth
- **Wildcard suffix** `admin.*` scores by pattern depth
- **No match** scores 0

If both allow and deny match, the more specific one wins. On equal specificity, **deny wins**.

### Upstream Matching

Supports:

- Exact: `10.0.0.5:3000`
- Port range: `10.0.0.5:3000-3099`
- CIDR: `10.0.0.0/24:*`
- Wildcard port: `10.0.0.5:*`

## Resource Tracking

The compose role tracks resource usage across all projects per client using a persistent JSON state file at `{deployments_dir}/resource-state.json`.

### Tracked Resources

| Resource    | How calculated                                                                    |
| ----------- | --------------------------------------------------------------------------------- |
| Containers  | Count of services in compose file                                                 |
| Memory (MB) | Sum of `mem_limit` per service, falling back to `per_container.default_memory_mb` |
| CPUs        | Sum of `cpus` per service, falling back to `per_container.default_cpus`           |

### Budget Checking

When deploying or updating a project, the tracker:

1. Calculates current usage across all **other** projects for the client (excludes the project being updated to prevent double-counting)
2. Adds the requested project's resources
3. Checks against `max_containers`, `max_memory_mb`, `max_cpus` from the client's compose policy
4. Rejects the deploy if any limit would be exceeded

### State Persistence

```json
{
  "clients": {
    "myproject": {
      "projects": {
        "my-app": { "containers": 3, "memory_mb": 768, "cpus": 1.5 },
        "worker": { "containers": 1, "memory_mb": 512, "cpus": 0.5 }
      }
    }
  }
}
```

The state file is updated on every deploy/destroy. The tracker is thread-safe (`sync.RWMutex`). On agent restart, the state is loaded from disk.

### Database Resource Tracking

The db role uses a separate state file at `{data_dir}/db-state.json`:

```json
{
  "clients": {
    "myproject": {
      "databases": {
        "myapp": {
          "database_name": "opsen_myproject_myapp",
          "owner_role": "opsen_myproject_myapp_myapp_user",
          "additional_roles": ["opsen_myproject_myapp_readonly"],
          "connection_limit": 20,
          "max_size_mb": 1024,
          "extensions": ["uuid-ossp", "pgcrypto"],
          "quota_exceeded": false
        }
      }
    }
  }
}
```

The tracker records database metadata, not live size. Actual sizes are queried from PostgreSQL on demand (status endpoints) and periodically (size monitor).

## Configuration

### Agent Config (`/etc/opsen-agent/agent.yaml`)

```yaml
listen: '0.0.0.0:8443'

tls:
  cert: /etc/opsen-agent/server.pem
  key: /etc/opsen-agent/server-key.pem
  ca: /etc/opsen-agent/ca.pem
  min_version: '1.3'

clients_dir: /etc/opsen-agent/clients/

roles:
  compose:
    compose_binary: docker compose
    deployments_dir: /var/lib/opsen-agent/deployments/
    network_prefix: opsen
  ingress:
    driver: traefik # or "caddy"
    config_dir: /etc/traefik/dynamic/
    reload_command: '' # traefik watches files; caddy needs "caddy reload"
  db:
    host: '127.0.0.1'
    port: 5432
    admin_user: opsen_manager
    admin_password_file: /etc/opsen-agent/db-password
    default_encoding: UTF8
    default_locale: 'en_US.UTF-8'
    size_check_interval: 60 # seconds
    ssl_mode: require # disable, require, verify-ca, verify-full
    data_dir: /var/lib/opsen-agent/db/

global_hardening:
  no_new_privileges: true
  cap_drop_all: true
  read_only_rootfs: true
  default_user: '1000:1000'
  default_tmpfs:
    - path: /tmp
      options: 'noexec,nosuid,size=64m'
  pid_limit: 100

deny:
  privileged: true
  network_modes: [host]
  pid_mode: host
  ipc_mode: host
  host_paths: ['/', '/etc', '/var/run/docker.sock', '/proc', '/sys', '/dev']

logging:
  file: /var/log/opsen-agent/agent.log
  audit_file: /var/log/opsen-agent/audit.log
  level: info

reload:
  watch_clients_dir: true
```

### Client Policy Files

Client policies are YAML files in `clients_dir`, named `{client}.yaml`. The agent watches this directory every 5 seconds and reloads policies automatically (when `watch_clients_dir: true`). No agent restart required to add/update/remove clients.

## Audit Logging

Every API action is logged to a structured JSON audit log at the configured `audit_file` path:

```json
{
  "ts": "2026-03-10T14:30:00Z",
  "client": "myproject",
  "action": "compose.deploy",
  "details": { "project": "my-app", "services": 3 },
  "policy_modifications": ["web: set cap_drop ALL", "web: set read_only true"],
  "result": "success"
}
```

## Systemd Integration

The agent runs as a hardened systemd service:

```ini
[Unit]
Description=Opsen Deploy Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/opsen-agent --config /etc/opsen-agent/agent.yaml
Restart=always
RestartSec=5
User=opsen-agent
Group=opsen-agent
SupplementaryGroups=docker           # only if compose role enabled
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/opsen-agent /var/log/opsen-agent
PrivateTmp=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

Key security features:

- Dedicated `opsen-agent` system user (no login shell, no home directory)
- `ProtectSystem=strict` — entire filesystem is read-only except `ReadWritePaths`
- `ProtectHome=true` — no access to `/home`, `/root`, `/run/user`
- `NoNewPrivileges=true` — no privilege escalation via SUID/SGID
- `CapabilityBoundingSet=` (empty) — no Linux capabilities
- `PrivateTmp=true` — isolated `/tmp`
- `SupplementaryGroups=docker` — only added when compose role is enabled (needed for Docker socket access)
- Ingress role adds its `configDir` to `ReadWritePaths`

## Pulumi Integration (`@opsen/agent`)

### Package Structure

```text
packages/agent/
├── package.json          # @opsen/agent - Pulumi component
├── tsconfig.json
├── src/
│   ├── index.ts          # Public exports
│   ├── agent-installer.ts # AgentInstaller ComponentResource
│   ├── config.ts         # Config serialization (TS -> YAML)
│   ├── pki.ts            # PKI helpers (CA, server certs, client certs)
│   └── types.ts          # TypeScript interfaces
└── go/
    ├── go.mod
    ├── go.sum
    ├── Dockerfile.build  # Multi-stage build for static binary
    ├── cmd/
    │   └── opsen-agent/
    │       └── main.go
    └── internal/
        ├── audit/
        │   └── logger.go
        ├── config/
        │   ├── agent.go  # Agent config types + loader
        │   └── client.go # Client policy types + store + watcher
        ├── identity/
        │   └── context.go # Context-based client identity (breaks import cycle)
        ├── policy/
        │   ├── domain.go  # Domain matching with specificity
        │   └── network.go # Upstream/CIDR/port matching
        ├── roles/
        │   ├── compose/
        │   │   ├── handler.go  # Deploy/Destroy/Status handlers
        │   │   ├── compose.go  # Parse/validate/harden compose files
        │   │   └── tracker.go  # Cross-project resource tracking
        │   ├── db/
        │   │   ├── handler.go   # CRUD handlers for databases and roles
        │   │   ├── postgres.go  # SQL operations (create/drop/grant/monitor)
        │   │   ├── tracker.go   # Database resource tracking
        │   │   ├── password.go  # Password policy validation
        │   │   ├── validate.go  # Name, limit, and extension validation
        │   │   └── monitor.go   # Background disk size monitor
        │   └── ingress/
        │       ├── handler.go  # Route handlers
        │       ├── driver.go   # Driver interface
        │       ├── traefik.go  # Traefik dynamic YAML driver
        │       └── caddy.go    # Caddyfile driver
        └── server/
            ├── server.go     # HTTP server with mTLS + role routing
            └── middleware.go  # Client cert extraction middleware
```

### AgentInstaller ComponentResource

`AgentInstaller` is a Pulumi `ComponentResource` that encapsulates the full deployment lifecycle:

```typescript
import { AgentInstaller, createPlatformCA, issueAgentCert, issueClientCert } from '@opsen/agent'

// Create PKI
const ca = createPlatformCA('platform')
const serverCert = issueAgentCert('worker-1', {
  caCertPem: ca.certPem,
  caPrivateKeyPem: ca.privateKeyPem,
  commonName: 'worker-1.internal',
  ipAddresses: ['10.0.0.5'],
})

// Deploy agent
const agent = new AgentInstaller('worker-1', {
  connection: { host: '10.0.0.5', user: 'root', privateKey: sshKey },
  config: {
    listen: '0.0.0.0:8443',
    roles: {
      compose: { deploymentsDir: '/var/lib/opsen-agent/deployments/' },
    },
  },
  clients: [
    {
      name: 'myproject',
      compose: {
        maxContainers: 20,
        maxMemoryMb: 4096,
        maxCpus: 4.0,
        perContainer: { defaultMemoryMb: 256, maxMemoryMb: 1024 },
      },
    },
  ],
  tls: { ca: ca.certPem, cert: serverCert.certPem, key: serverCert.privateKeyPem },
})

// Issue client cert for deployments
const clientCert = issueClientCert('myproject', {
  caCertPem: ca.certPem,
  caPrivateKeyPem: ca.privateKeyPem,
  clientName: 'myproject',
})
```

### Resource Granularity

The `AgentInstaller` creates individual Pulumi resources for each concern:

| Resource                   | Type                          | Trigger                                    |
| -------------------------- | ----------------------------- | ------------------------------------------ |
| `{name}-build`             | `command.local.Command`       | Source hash (Go files, go.mod, Dockerfile) |
| `{name}-setup`             | `command.remote.Command`      | Once (creates user, dirs)                  |
| `{name}-binary`            | `command.remote.CopyToRemote` | Binary hash                                |
| `{name}-chmod`             | `command.remote.Command`      | Binary hash                                |
| `{name}-tls-{ca,cert,key}` | `command.remote.Command`      | Content hash                               |
| `{name}-config`            | `command.remote.Command`      | Config content hash                        |
| `{name}-client-{name}`     | `command.remote.Command`      | Policy content hash                        |
| `{name}-service`           | `command.remote.Command`      | Binary hash + config hash                  |

This means:

- Changing a client policy **only** re-uploads that policy file (no binary rebuild, no restart)
- Changing agent config re-uploads config **and** restarts the service
- Changing Go source code rebuilds the binary, re-uploads, and restarts
- Adding a new client only creates the new policy file

### Build Process

The Go binary is built locally in Docker (not on the remote VM):

```dockerfile
FROM golang:1.23-alpine AS builder
RUN apk add --no-cache git
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /opsen-agent ./cmd/opsen-agent

FROM scratch
COPY --from=builder /opsen-agent /opsen-agent
```

- `CGO_ENABLED=0` produces a fully static binary
- `-ldflags="-s -w"` strips debug info (~6MB output)
- Source hash is computed from `go.mod`, `go.sum`, `Dockerfile.build`, and all `*.go` files
- Binary is output to `go/out/opsen-agent` via Docker BuildKit local export

### PKI Functions

| Function             | Purpose                             | Key Type   | Validity |
| -------------------- | ----------------------------------- | ---------- | -------- |
| `createPlatformCA()` | Self-signed root CA                 | ECDSA P384 | 10 years |
| `issueAgentCert()`   | Server certificate with IP/DNS SANs | ECDSA P256 | 1 year   |
| `issueClientCert()`  | Client certificate (CN=client name) | ECDSA P256 | 1 year   |

All use `@pulumi/tls` resources for declarative cert management.

### Config Serialization

TypeScript config objects (camelCase) are serialized to YAML (snake_case) for the Go agent. The `@opsen/agent` package includes a custom YAML serializer (`config.ts`) with no external YAML dependencies — `toYaml()` handles objects, arrays, and scalar types with proper indentation.

## HTTP Server

- **Read timeout**: 30 seconds
- **Write timeout**: 120 seconds (compose deploys can take time)
- **Idle timeout**: 60 seconds
- **Graceful shutdown**: 10-second timeout on SIGINT/SIGTERM

## File System Layout

```text
/usr/local/bin/opsen-agent           # Binary
/etc/opsen-agent/
├── agent.yaml                       # Agent configuration
├── ca.pem                           # Platform CA certificate
├── server.pem                       # Server certificate
├── server-key.pem                   # Server private key (mode 600)
└── clients/
    ├── myproject.yaml               # Client policy
    └── another-client.yaml
/var/lib/opsen-agent/
├── deployments/
│   ├── resource-state.json          # Cross-project compose resource tracker
│   └── {client}/
│       └── {project}/
│           ├── compose.yml          # Hardened compose file
│           └── ...                  # Other project files
└── db/
    └── db-state.json                # Database resource tracker
/var/log/opsen-agent/
├── agent.log                        # Structured JSON application log
└── audit.log                        # Structured JSON audit log
```

## Security Model Summary

| Layer                | Mechanism                                                              |
| -------------------- | ---------------------------------------------------------------------- |
| Transport            | mTLS with platform CA, TLS 1.3 minimum                                 |
| Authentication       | Client certificate CN maps to policy                                   |
| Authorization        | Per-client role enablement (compose/ingress/db)                        |
| Compose validation   | Deny-list (privileged, host network, host paths, etc.)                 |
| Compose hardening    | Automatic injection (no-new-privileges, cap_drop ALL, read_only, etc.) |
| Network isolation    | Docker `--internal` networks per project (no internet by default)      |
| Resource limits      | Cross-project budget tracking (containers, memory, CPU)                |
| Ingress validation   | Domain allow/deny, upstream allow/deny, rate limit caps                |
| DB isolation         | Separate database per project, REVOKE CONNECT FROM PUBLIC              |
| DB resource limits   | Connection limits, GUC parameters, disk quota monitoring               |
| DB credential policy | Password complexity, username deny lists, SCRAM-SHA-256                |
| DB SQL safety        | Identifier quoting, parameterized queries, GUC allowlist               |
| Agent process        | systemd hardening (ProtectSystem=strict, no capabilities, PrivateTmp)  |
| File paths           | Sanitized, no path traversal, restricted host paths                    |
| Logging              | Forced json-file driver with size limits on all containers             |

## Dependencies

### Go

- `gopkg.in/yaml.v3` — YAML parsing for config and compose files
- `github.com/lib/pq` — PostgreSQL driver for `database/sql` (db role)
- Standard library only for everything else (crypto, net, http, os, etc.)

### TypeScript (Pulumi)

- `@pulumi/pulumi` — Core Pulumi SDK
- `@pulumi/command` — Local/remote command execution and file copy
- `@pulumi/tls` — PKI certificate management

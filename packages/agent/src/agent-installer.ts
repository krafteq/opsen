import * as pulumi from '@pulumi/pulumi'
import * as command from '@pulumi/command'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { serializeAgentConfig, serializeClientPolicy } from './config.js'
import type { AgentInstallerArgs } from './types.js'

const GO_SRC_DIR = path.resolve(import.meta.dirname, '..', 'go')

export class AgentInstaller extends pulumi.ComponentResource {
  declare readonly endpoint: pulumi.Output<string>
  declare readonly binaryHash: pulumi.Output<string>

  constructor(name: string, args: AgentInstallerArgs, opts?: pulumi.ComponentResourceOptions) {
    super('opsen:agent:Installer', name, {}, opts)

    const conn = args.connection

    // ─── Build binary locally in Docker ─────────────────
    const sourceHash = computeSourceHash(GO_SRC_DIR)

    const build = new command.local.Command(
      `${name}-build`,
      {
        dir: GO_SRC_DIR,
        create:
          'docker build -f Dockerfile.build -o type=local,dest=./out . 2>&1 && sha256sum ./out/opsen-agent | cut -d" " -f1',
        triggers: [sourceHash],
      },
      { parent: this },
    )

    const binHash = build.stdout.apply((out) => out.trim().split('\n').pop()!.trim())

    // ─── Setup remote directories + user ────────────────
    const setupCommands = pulumi.output(args.config).apply((config) => {
      const cmds = [
        'set -e',
        'id -u opsen-agent &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin opsen-agent',
        'mkdir -p /etc/opsen-agent/clients /var/lib/opsen-agent/deployments /var/lib/opsen-agent/db /var/log/opsen-agent',
        'chown -R opsen-agent:opsen-agent /var/lib/opsen-agent /var/log/opsen-agent',
      ]
      if (config.roles?.ingress?.configDir) {
        cmds.push(`chown opsen-agent:opsen-agent ${config.roles.ingress.configDir}`)
      }
      return cmds.join('\n')
    })

    const setup = new command.remote.Command(
      `${name}-setup`,
      {
        connection: conn,
        create: setupCommands,
        delete: [
          'systemctl stop opsen-agent 2>/dev/null || true',
          'systemctl disable opsen-agent 2>/dev/null || true',
          'rm -f /etc/systemd/system/opsen-agent.service /usr/local/bin/opsen-agent',
          'rm -rf /etc/opsen-agent /var/lib/opsen-agent /var/log/opsen-agent',
          'userdel opsen-agent 2>/dev/null || true',
          'systemctl daemon-reload',
        ].join('\n'),
      },
      { parent: this },
    )

    // ─── Upload binary ──────────────────────────────────
    const binary = new command.remote.CopyToRemote(
      `${name}-binary`,
      {
        connection: conn,
        source: new pulumi.asset.FileAsset(path.join(GO_SRC_DIR, 'out', 'opsen-agent')),
        remotePath: '/usr/local/bin/opsen-agent',
        triggers: [binHash],
      },
      { parent: this, dependsOn: [build, setup] },
    )

    const chmod = new command.remote.Command(
      `${name}-chmod`,
      {
        connection: conn,
        create: 'chmod +x /usr/local/bin/opsen-agent',
        triggers: [binHash],
      },
      { parent: this, dependsOn: [binary] },
    )

    // ─── Upload TLS certs ───────────────────────────────
    const tlsResources = uploadTlsCerts(name, conn, args.tls, this, setup)

    // ─── Write agent config ─────────────────────────────
    const configYaml = pulumi.output(args.config).apply((c) => serializeAgentConfig(c))
    const configHash = configYaml.apply((y) => hashString(y))

    const agentConfig = new command.remote.Command(
      `${name}-config`,
      {
        connection: conn,
        create: pulumi.interpolate`cat > /etc/opsen-agent/agent.yaml << 'OPSENEOF'\n${configYaml}\nOPSENEOF`,
        triggers: [configHash],
      },
      { parent: this, dependsOn: [setup] },
    )

    // ─── Write client policies ──────────────────────────
    const clientResources = (args.clients ?? []).map((client) => {
      const clientName = pulumi.output(client.name)
      const policyYaml = pulumi.output(client).apply((c) => serializeClientPolicy(c))
      const policyHash = policyYaml.apply((y) => hashString(y))

      return new command.remote.Command(
        `${name}-client-${client.name}`,
        {
          connection: conn,
          create: pulumi.interpolate`cat > /etc/opsen-agent/clients/${clientName}.yaml << 'OPSENEOF'\n${policyYaml}\nOPSENEOF`,
          delete: pulumi.interpolate`rm -f /etc/opsen-agent/clients/${clientName}.yaml`,
          triggers: [policyHash],
        },
        { parent: this, dependsOn: [setup] },
      )
    })

    // ─── Systemd unit + start ───────────────────────────
    const systemdUnit = buildSystemdUnit(args)
    const restartTrigger = pulumi.all([binHash, configHash]).apply(([b, c]) => `${b}-${c}`)

    new command.remote.Command(
      `${name}-service`,
      {
        connection: conn,
        create: pulumi.interpolate`cat > /etc/systemd/system/opsen-agent.service << 'OPSENEOF'\n${systemdUnit}\nOPSENEOF
systemctl daemon-reload
systemctl enable opsen-agent
systemctl restart opsen-agent
for i in $(seq 1 15); do
  sleep 1
  systemctl is-active --quiet opsen-agent && exit 0
done
echo "opsen-agent failed to start" >&2
journalctl -u opsen-agent --no-pager -n 30 >&2
exit 1`,
        triggers: [restartTrigger],
      },
      { parent: this, dependsOn: [chmod, agentConfig, ...tlsResources, ...clientResources] },
    )

    // ─── Outputs ────────────────────────────────────────
    const listenAddr = pulumi.output(args.config).apply((c) => c.listen)
    this.endpoint = pulumi.interpolate`https://${listenAddr}`
    this.binaryHash = binHash

    this.registerOutputs({
      endpoint: this.endpoint,
      binaryHash: this.binaryHash,
    })
  }
}

function uploadTlsCerts(
  name: string,
  conn: command.types.input.remote.ConnectionArgs,
  tls: AgentInstallerArgs['tls'],
  parent: pulumi.Resource,
  dependsOn: pulumi.Resource,
): command.remote.Command[] {
  const files = [
    { key: 'ca', remotePath: '/etc/opsen-agent/ca.pem', content: tls.ca, mode: '644' },
    { key: 'cert', remotePath: '/etc/opsen-agent/server.pem', content: tls.cert, mode: '644' },
    { key: 'key', remotePath: '/etc/opsen-agent/server-key.pem', content: tls.key, mode: '600' },
  ]

  return files.map(
    (f) =>
      new command.remote.Command(
        `${name}-tls-${f.key}`,
        {
          connection: conn,
          create: pulumi.interpolate`cat > ${f.remotePath} << 'OPSENEOF'\n${f.content}\nOPSENEOF
chmod ${f.mode} ${f.remotePath}
chown opsen-agent:opsen-agent ${f.remotePath}`,
          triggers: [pulumi.output(f.content).apply((c) => hashString(c))],
        },
        { parent, dependsOn: [dependsOn] },
      ),
  )
}

function buildSystemdUnit(args: AgentInstallerArgs): pulumi.Output<string> {
  return pulumi.output(args.config).apply((config) => {
    const hasCompose = !!config.roles?.compose
    const hasIngress = !!config.roles?.ingress
    const supplementaryGroups = hasCompose ? 'SupplementaryGroups=docker' : ''
    // ProtectHome breaks docker compose plugin discovery, so disable when compose role is active
    const protectHome = hasCompose ? 'ProtectHome=tmpfs' : 'ProtectHome=true'

    const writePaths = ['/var/lib/opsen-agent', '/var/log/opsen-agent']
    if (hasIngress && config.roles?.ingress?.configDir) {
      writePaths.push(config.roles.ingress.configDir)
    }

    return `[Unit]
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
${supplementaryGroups}
NoNewPrivileges=true
ProtectSystem=strict
${protectHome}
ReadWritePaths=${writePaths.join(' ')}
PrivateTmp=true

[Install]
WantedBy=multi-user.target`
  })
}

function computeSourceHash(dir: string): string {
  const hash = crypto.createHash('sha256')
  const patterns = ['go.mod', 'go.sum', 'Dockerfile.build']

  for (const pattern of patterns) {
    const filePath = path.join(dir, pattern)
    if (fs.existsSync(filePath)) {
      hash.update(fs.readFileSync(filePath))
    }
  }

  walkGoFiles(dir, (filePath) => {
    hash.update(fs.readFileSync(filePath))
  })

  return hash.digest('hex')
}

function walkGoFiles(dir: string, callback: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'out' && entry.name !== 'vendor') {
      walkGoFiles(fullPath, callback)
    } else if (entry.isFile() && entry.name.endsWith('.go')) {
      callback(fullPath)
    }
  }
}

function hashString(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
}

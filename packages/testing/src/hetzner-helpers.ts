import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

export interface HetznerTestVm {
  /** Server name in Hetzner Cloud */
  serverName: string
  /** Public IPv4 address */
  ipv4: string
  /** SSH connection details ready for use with @opsen/docker-compose */
  connection: {
    host: string
    user: string
    privateKey: string
  }
  /** Destroy the VM */
  destroy: () => void
}

function hcloud(args: string[], timeout = 60_000): string {
  return execFileSync('hcloud', args, {
    stdio: 'pipe',
    timeout,
    env: { ...process.env, HCLOUD_TOKEN: process.env.HETZNER_API_TOKEN },
  })
    .toString()
    .trim()
}

/**
 * Create a Hetzner Cloud VM with Docker pre-installed for e2e testing.
 * Uses `hcloud` CLI directly (not Pulumi) so infrastructure exists before tests run.
 *
 * Requires:
 * - `HETZNER_API_TOKEN` env var
 * - `~/.ssh/id_ed25519` SSH key pair
 */
export function createHetznerTestVm(opts?: { testId?: string; location?: string; serverType?: string }): HetznerTestVm {
  const testId = opts?.testId ?? randomBytes(4).toString('hex')
  const location = opts?.location ?? 'fsn1'
  const serverType = opts?.serverType ?? 'cx23'
  const serverName = `opsen-e2e-${testId}`
  const sshKeyName = `opsen-e2e-${testId}`

  const sshPubKey = readFileSync(join(process.env.HOME!, '.ssh', 'id_ed25519.pub'), 'utf8').trim()
  const sshPrivateKey = readFileSync(join(process.env.HOME!, '.ssh', 'id_ed25519'), 'utf8')

  const cloudInit = `#cloud-config
package_update: true
packages:
  - ca-certificates
  - curl

runcmd:
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - systemctl enable docker
  - systemctl start docker
  - touch /tmp/cloud-init-done
`

  console.log(`[hetzner-helpers] Creating SSH key: ${sshKeyName}`)
  hcloud(['ssh-key', 'create', '--name', sshKeyName, '--public-key', sshPubKey])

  console.log(`[hetzner-helpers] Creating server: ${serverName} (${serverType} in ${location})`)
  const cloudInitFile = join(tmpdir(), `opsen-e2e-cloud-init-${testId}.yaml`)
  writeFileSync(cloudInitFile, cloudInit)
  try {
    hcloud(
      [
        'server',
        'create',
        '--name',
        serverName,
        '--type',
        serverType,
        '--image',
        'ubuntu-24.04',
        '--location',
        location,
        '--ssh-key',
        sshKeyName,
        '--user-data-from-file',
        cloudInitFile,
      ],
      120_000,
    )
  } finally {
    unlinkSync(cloudInitFile)
  }

  const ipv4 = hcloud(['server', 'ip', serverName])
  console.log(`[hetzner-helpers] Server ready: ${serverName} (${ipv4})`)

  // Wait for cloud-init to finish (Docker installed)
  console.log('[hetzner-helpers] Waiting for cloud-init (Docker install)...')
  const sshArgs = [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-i',
    join(process.env.HOME!, '.ssh', 'id_ed25519'),
  ]
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    try {
      execFileSync('ssh', [...sshArgs, `root@${ipv4}`, '[ -f /tmp/cloud-init-done ]'], {
        stdio: 'pipe',
        timeout: 15_000,
      })
      break
    } catch {
      execFileSync('sleep', ['5'], { stdio: 'pipe' })
    }
  }
  if (Date.now() >= deadline) {
    throw new Error(`[hetzner-helpers] cloud-init timeout on ${serverName}`)
  }
  console.log('[hetzner-helpers] cloud-init done, Docker is ready')

  return {
    serverName,
    ipv4,
    connection: {
      host: ipv4,
      user: 'root',
      privateKey: sshPrivateKey,
    },
    destroy: () => destroyHetznerTestVm(serverName, sshKeyName),
  }
}

/**
 * Destroy a Hetzner test VM and its SSH key. Best-effort — won't throw on failure.
 */
export function destroyHetznerTestVm(serverName: string, sshKeyName?: string): void {
  try {
    console.log(`[hetzner-helpers] Deleting server: ${serverName}`)
    hcloud(['server', 'delete', serverName])
  } catch (err) {
    console.error(`[hetzner-helpers] Failed to delete server ${serverName}:`, err)
  }
  if (sshKeyName) {
    try {
      hcloud(['ssh-key', 'delete', sshKeyName])
    } catch {
      // ignore
    }
  }
}

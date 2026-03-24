import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { isPulumiAvailable, isHetznerAvailable, createHetznerTestVm } from '@opsen/testing'
import type { HetznerTestVm } from '@opsen/testing'

const canRun = isPulumiAvailable() && isHetznerAvailable()

let vm: HetznerTestVm | undefined

beforeAll(async () => {
  if (!canRun) return
  vm = createHetznerTestVm()
}, 600_000)

afterAll(() => {
  vm?.destroy()
}, 120_000)

const sshBaseArgs = [
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-i',
  join(process.env.HOME!, '.ssh', 'id_ed25519'),
]

function ssh(cmd: string): string {
  return execFileSync('ssh', [...sshBaseArgs, `root@${vm!.ipv4}`, cmd], {
    stdio: 'pipe',
    timeout: 60_000,
  })
    .toString()
    .trim()
}

/** Write a compose file and run the same command DockerCompose uses */
function composeUp(composeYaml: string): void {
  ssh('mkdir -p /opt/e2e-test')
  ssh(`cat > /opt/e2e-test/docker-compose.yml << 'YAML'\n${composeYaml}\nYAML`)
  ssh('cd /opt/e2e-test && docker compose up -d --wait --build --remove-orphans')
}

describe.skipIf(!canRun)('DockerCompose e2e', () => {
  it('deploys, updates without downtime, and removes orphans', () => {
    // ── Step 1: Deploy two services ─────────────────────────────
    composeUp(
      [
        'services:',
        '  web:',
        '    image: nginx:alpine',
        '    restart: unless-stopped',
        '  redis:',
        '    image: redis:7-alpine',
        '    restart: unless-stopped',
      ].join('\n'),
    )

    const containers = ssh('docker ps --format "{{.Names}}" | sort')
    expect(containers).toContain('web')
    expect(containers).toContain('redis')

    // Record redis container ID before update
    const redisIdBefore = ssh('docker ps -q --filter name=redis')
    expect(redisIdBefore).toBeTruthy()

    // ── Step 2: Update env on web only → redis stays untouched ──
    composeUp(
      [
        'services:',
        '  web:',
        '    image: nginx:alpine',
        '    restart: unless-stopped',
        '    environment:',
        '      UPDATED: "true"',
        '  redis:',
        '    image: redis:7-alpine',
        '    restart: unless-stopped',
      ].join('\n'),
    )

    // Redis container should be the same (not recreated)
    const redisIdAfter = ssh('docker ps -q --filter name=redis')
    expect(redisIdAfter).toBe(redisIdBefore)

    // Web should have the new env var
    const webEnv = ssh('docker exec $(docker ps -q --filter name=web) printenv UPDATED')
    expect(webEnv).toBe('true')

    // ── Step 3: Remove redis → orphan cleanup ───────────────────
    composeUp(['services:', '  web:', '    image: nginx:alpine', '    restart: unless-stopped'].join('\n'))

    // Web should still be running
    const webContainer = ssh('docker ps --filter name=web --format "{{.Names}}"')
    expect(webContainer).toContain('web')

    // Redis should be gone (orphan removed by --remove-orphans)
    const redisContainer = ssh('docker ps --filter name=redis --format "{{.Names}}"')
    expect(redisContainer).toBe('')
  }, 300_000)
})

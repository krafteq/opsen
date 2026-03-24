import { execFileSync } from 'node:child_process'

function commandSucceeds(cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', timeout: 15_000, env })
    return true
  } catch {
    return false
  }
}

export function isPulumiAvailable(): boolean {
  return commandSucceeds('pulumi', ['version'])
}

export function isDockerAvailable(): boolean {
  return commandSucceeds('docker', ['info'])
}

export function isAzureAvailable(subscriptionId?: string): boolean {
  if (!commandSucceeds('az', ['account', 'show'])) return false
  if (subscriptionId) {
    try {
      const out = execFileSync('az', ['account', 'show', '--query', 'id', '-o', 'tsv'], {
        stdio: 'pipe',
        timeout: 15_000,
      })
      return out.toString().trim() === subscriptionId
    } catch {
      return false
    }
  }
  return true
}

export function isKubernetesAvailable(): boolean {
  return commandSucceeds('kubectl', ['cluster-info'])
}

export function isHetznerAvailable(): boolean {
  if (!process.env.HETZNER_API_TOKEN) return false
  return commandSucceeds('hcloud', ['server', 'list'], {
    ...process.env,
    HCLOUD_TOKEN: process.env.HETZNER_API_TOKEN,
  })
}

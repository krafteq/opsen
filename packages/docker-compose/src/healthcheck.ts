/**
 * Generates a bash retry loop that wraps a health check command.
 * Used by DockerCompose healthCheck strings to wait for services to become ready.
 */
export function waitForReady(
  check: string,
  opts?: {
    retries?: number
    interval?: number
    name?: string
  },
): string {
  const retries = opts?.retries ?? 30
  const interval = opts?.interval ?? 2
  const name = opts?.name ?? 'service'

  // Escape single quotes in the check command for embedding in bash -c '...'
  const escapedCheck = check.replace(/'/g, "'\\''")

  return `bash -c 'for i in $(seq 1 ${retries}); do if ${escapedCheck}; then echo "${name} ready"; exit 0; fi; echo "${name} not ready ($i/${retries})..."; sleep ${interval}; done; echo "${name} FAILED to become ready"; exit 1'`
}

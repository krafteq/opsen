import { execFileSync } from 'node:child_process'

/**
 * Assert that a Docker container with the given name prefix is running.
 */
export function assertDockerContainerRunning(namePrefix: string): void {
  const output = execFileSync('docker', ['ps', '--filter', `name=${namePrefix}`, '--format', '{{.Names}}'], {
    stdio: 'pipe',
    timeout: 10_000,
  })
    .toString()
    .trim()

  if (!output) {
    throw new Error(`No running container found matching name prefix: ${namePrefix}`)
  }
}

/**
 * Assert that a Docker network with the given name exists.
 */
export function assertDockerNetworkExists(name: string): void {
  try {
    execFileSync('docker', ['network', 'inspect', name], { stdio: 'pipe', timeout: 10_000 })
  } catch {
    throw new Error(`Docker network not found: ${name}`)
  }
}

/**
 * Assert that an HTTP endpoint responds with the expected status code.
 * Retries with exponential backoff until timeout.
 */
export async function assertHttpEndpoint(
  url: string,
  opts?: {
    expectedStatus?: number
    expectedBodyContains?: string
    timeout?: number
    retryInterval?: number
  },
): Promise<string> {
  const expectedStatus = opts?.expectedStatus ?? 200
  const timeout = opts?.timeout ?? 30_000
  const retryInterval = opts?.retryInterval ?? 2_000
  const deadline = Date.now() + timeout

  let lastError: Error | undefined

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status !== expectedStatus) {
        lastError = new Error(`Expected status ${expectedStatus}, got ${response.status}`)
      } else {
        const body = await response.text()
        if (opts?.expectedBodyContains && !body.includes(opts.expectedBodyContains)) {
          lastError = new Error(
            `Response body does not contain "${opts.expectedBodyContains}". Got: ${body.substring(0, 200)}`,
          )
        } else {
          return body
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }

    await new Promise((resolve) => setTimeout(resolve, retryInterval))
  }

  throw new Error(`HTTP endpoint ${url} did not respond within ${timeout}ms. Last error: ${lastError?.message}`)
}

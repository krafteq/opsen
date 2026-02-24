import { ComputeResources, ResourceRequirements } from '@opsen/platform'

/**
 * Parse an Opsen `ComputeResources` descriptor into Kubernetes `ResourceRequirements`.
 *
 * Accepts either the string shorthand `"cpuReq/cpuLim,memReq/memLim"` or the
 * object form `{ cpu: "req/lim", memory: "req/lim" }`.
 */
export function parseResourceRequirements(req: ComputeResources): ResourceRequirements {
  const [cpu, memory] = typeof req == 'string' ? req.split(',') : [req.cpu, req.memory]

  return {
    requests: {
      cpu: cpu.split('/')[0],
      memory: memory.split('/')[0],
    },
    limits: {
      cpu: cpu.split('/')[1],
      memory: memory.split('/')[1],
    },
  }
}

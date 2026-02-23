/**
 * Easy describe compute resources. Samples:
 * - "100m/1000m,100Mi/2Gi"
 * - { cpu: "100m/1000m", memory: "100Mi/2Gi" }
 */
export type ComputeResources =
  | {
      cpu: string
      memory: string
    }
  | string

export interface ResourceRequirements {
  requests: ResourceMetrics
  limits: ResourceMetrics
}

export interface ResourceMetrics extends Record<string, string> {
  memory: string
  cpu: string
}

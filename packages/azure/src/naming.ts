/**
 * Context passed to naming convention methods.
 */
export interface AzureResourceNameContext {
  /** The deployer name (from deployer args) */
  deployerName: string
  /** The workload name (from WorkloadMetadata.name) */
  workloadName: string
  /** The process name within the workload */
  processName: string
}

/**
 * Injectable naming convention for Azure resources.
 *
 * Controls how compute resource names (Web App, Container App) and
 * related sub-resource name prefixes are generated.
 */
export interface AzureNaming {
  /** Generate the name for a compute resource (Web App, Container App). */
  resourceName(ctx: AzureResourceNameContext): string
}

/**
 * Default naming convention: `${deployerName}-${workloadName}-${processName}`.
 *
 * Includes the deployer name to prevent collisions when multiple deployers
 * create resources with the same workload/process names.
 */
export function defaultAzureNaming(): AzureNaming {
  return {
    resourceName(ctx) {
      return `${ctx.deployerName}-${ctx.workloadName}-${ctx.processName}`
    },
  }
}

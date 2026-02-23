import { DeployedWorkload, Workload } from './workload'
import { NoSpecificRuntime, WorkloadRuntime } from './runtime'
import * as pulumi from '@pulumi/pulumi'
import { PlatformResource, PlatformResourceRequest } from './resource'

export interface Platform<
  TWorkloadRuntime extends WorkloadRuntime = NoSpecificRuntime,
  TCapabilities extends PlatformCapabilities = PlatformCapabilities,
> {
  capabilities(): TCapabilities
  getProvider(name: string): pulumi.ProviderResource
  deploy(name: string, spec: Workload<TWorkloadRuntime>): pulumi.Output<DeployedWorkload>
  canCreateResource(request: PlatformResourceRequest): boolean
  createResource(name: string, request: PlatformResourceRequest): pulumi.Output<PlatformResource>
}

export interface PlatformCapabilities {
  resources: {
    kind: string
    apiVersion: string
  }[]
  workloadRuntimes: {
    kind: string
  }[]
  providers: {
    kind: string
    name: string
  }[]
}

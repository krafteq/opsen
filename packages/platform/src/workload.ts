import * as pulumi from '@pulumi/pulumi'
import { NoSpecificRuntime, WorkloadRuntime } from './runtime'
import { TwoLevelPartial } from './utils/types'

export type Workload<TPlatformSpecifics extends WorkloadRuntime<any, any, any, any> = NoSpecificRuntime> =
  TPlatformSpecifics extends WorkloadRuntime<infer TWorkload, unknown, unknown>
    ? TwoLevelPartial<TWorkload> &
        Partial<
          Omit<WorkloadProcess<TPlatformSpecifics>, 'disabled' | 'ports'> & {
            processes: pulumi.Input<Record<string, pulumi.Input<WorkloadProcess<TPlatformSpecifics>>>>
            endpoints?: pulumi.Input<Record<string, pulumi.Input<ServiceEndpoint<TPlatformSpecifics>>>>
          }
        >
    : never

export type WorkloadProcess<TPlatform extends WorkloadRuntime = NoSpecificRuntime> =
  TPlatform extends WorkloadRuntime<unknown, infer TProcess, unknown>
    ? TwoLevelPartial<TProcess> & {
        disabled?: boolean
        image?: pulumi.Input<string>
        cmd?: pulumi.Input<pulumi.Input<string>[]>
        env?: pulumi.Input<Record<string, pulumi.Input<string | undefined>>>
        files?: MappedFile[]
        volumes?: pulumi.Input<Record<string, pulumi.Input<Volume<TPlatform>>>>
        healthcheck?: HealthcheckOptions
        ports?: pulumi.Input<Record<string, ProcessPort>>
        deployStrategy?: pulumi.Input<DeployStrategy>
        scale?: pulumi.Input<number>
      }
    : never

export type ServiceEndpoint<TPlatform extends WorkloadRuntime = NoSpecificRuntime> =
  TPlatform extends WorkloadRuntime<unknown, unknown, unknown, infer TIngress>
    ? {
        servicePort?: number
        ingress?: TwoLevelPartial<TIngress> & {
          hosts?: pulumi.Input<pulumi.Input<string>[]>
          path?: pulumi.Input<string>
          enableCors?: pulumi.Input<boolean>
          bodySize?: pulumi.Input<string>
        }

        backend: {
          process: string
          port: string
        }
      }
    : never

export type ProcessPortProtocol = 'tcp' | 'sctp' | 'udp' | 'http' | 'https' | 'grpc'

export interface ProcessPort {
  port: number
  protocol: ProcessPortProtocol
}

export interface MappedFile {
  path: string
  content: pulumi.Input<string>
}

export interface HealthcheckOptions {
  startup?: Probe
  readiness?: Probe
  liveness?: Probe
}

export interface Probe {
  initialDelaySeconds?: number
  timeoutSeconds?: number
  periodSeconds?: number
  successThreshold?: number
  failureThreshold?: number
  action: ExecProbeAction | HttpGetProbeAction
}

export interface ExecProbeAction {
  type: 'exec'
  cmd: pulumi.Input<string[]>
}

export interface HttpGetProbeAction {
  type: 'http-get'
  httpGet: {
    path: string
    port: number
  }
}

export type Volume<TPlatform extends WorkloadRuntime = NoSpecificRuntime> =
  TPlatform extends WorkloadRuntime<infer _TWorkload, infer _TProcess, infer TVolume>
    ? TwoLevelPartial<TVolume> & {
        path: string
        size?: string
      }
    : never

export interface WorkloadMetadata {
  name: string
  labels?: Record<string, string | boolean>
}

export interface DeployStrategy {
  type: 'Recreate' | 'RollingUpdate'
}

export interface DeployedWorkload {
  processes: Record<string, DeployedProcess>
  endpoints: Record<string, DeployedServiceEndpoint>
}

export interface DeployedServiceEndpoint {
  host: string
  port: number
}

export interface DeployedProcess {}

import { DefineRuntime } from '@opsen/platform'

export type AzureRuntime = DefineRuntime<
  '_az',
  {
    volume: {
      _az: {
        /** Hint: data must survive container restarts (default: false).
         *  ACA deployer: true → AzureFile, false → EmptyDir.
         *  WebApp deployer: true → Azure Files path mapping, false → ephemeral. */
        persistent?: boolean
      }
    }
    process: {
      _az: {
        minReplicas?: number
        maxReplicas?: number
        /** vCPU cores */
        cpu?: number
        /** GiB */
        memory?: number
      }
    }
    ingress: {
      _az: {
        /** Hint: endpoint needs WAF protection — deployer wires App Gateway */
        waf?: boolean
      }
    }
    workload: {
      _az: {}
    }
  }
>

/** @deprecated Use AzureRuntime instead */
export type AzureContainerAppsRuntime = AzureRuntime

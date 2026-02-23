import { DefineRuntime } from '../runtime'

export type AzureContainerAppsRuntime = DefineRuntime<
  '_aca',
  {
    volume: {
      _aca: {
        storageType?: 'AzureFile' | 'EmptyDir'
        storageName?: string
      }
    }
    ingress: {
      _aca: {
        customDomains?: { name: string; certificateId?: string }[]
      }
    }
    workload: {
      _aca: {
        environmentId?: string
        workloadProfileName?: string
      }
    }
    process: {
      _aca: {
        minReplicas?: number
        maxReplicas?: number
        cpuCores?: number
        memoryGi?: number
      }
    }
  }
>

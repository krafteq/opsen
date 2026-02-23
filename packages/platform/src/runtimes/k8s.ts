import { DefineRuntime } from '../runtime'
import { ComputeResources } from '../interfaces/compute'
import { Storage } from '../interfaces/storage'

export type KubernetesRuntime = DefineRuntime<
  '_k8s',
  {
    volume: {
      _k8s: {
        storage: Storage
      }
    }
    ingress: {
      _k8s: {}
    }
    workload: {
      _k8s: {
        resources: ComputeResources
      }
    }
    process: {
      _k8s: {
        resources: ComputeResources
      }
    }
  }
>

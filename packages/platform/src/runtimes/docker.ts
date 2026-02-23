import { DefineRuntime } from '../runtime'

export type DockerRuntime = DefineRuntime<
  '_docker',
  {
    volume: {
      _docker: {
        driver?: string
        driverOpts?: Record<string, string>
      }
    }
    ingress: {
      _docker: {
        acmeEmail?: string
      }
    }
    workload: {
      _docker: {
        restart?: 'no' | 'always' | 'on-failure' | 'unless-stopped'
        memoryMb?: number
        cpus?: number
      }
    }
    process: {
      _docker: {
        restart?: 'no' | 'always' | 'on-failure' | 'unless-stopped'
        memoryMb?: number
        cpus?: number
        networkMode?: string
      }
    }
  }
>

export interface WorkloadRuntime<TWorkload = {}, TProcess = {}, TVolume = {}, TIngress = {}> {
  volume: TVolume
  process: TProcess
  workload: TWorkload
  ingress: TIngress
}

export type NoSpecificRuntime = WorkloadRuntime

export type DefineRuntime<
  TName extends string,
  TPlatform extends WorkloadRuntime<Record<TName, {}>, Record<TName, {}>, Record<TName, {}>, Record<TName, {}>>,
> = TPlatform

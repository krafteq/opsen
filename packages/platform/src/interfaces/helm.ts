import * as pulumi from '@pulumi/pulumi'

export interface HelmOverride<TValues = any> {
  version?: pulumi.Input<string>
  values?: pulumi.Input<TValues>
}

export interface HelmMeta {
  chart: string
  version: string
  repo: string
}

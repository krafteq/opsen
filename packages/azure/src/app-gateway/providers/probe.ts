import * as pulumi from '@pulumi/pulumi'
import { AzureConnection } from '../azure-connection'
import { createSubResourceProvider } from './app-gateway-sub-resource'

export interface AppGatewayProbeInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  protocol: pulumi.Input<'Http' | 'Https'>
  host?: pulumi.Input<string>
  path: pulumi.Input<string>
  interval?: pulumi.Input<number>
  timeout?: pulumi.Input<number>
  unhealthyThreshold?: pulumi.Input<number>
  /** Pick host from backend HTTP settings (default true) */
  pickHostNameFromBackendHttpSettings?: pulumi.Input<boolean>
}

const provider = createSubResourceProvider({
  arrayProperty: 'probes',
  displayName: 'Health Probe',
})

export class AppGatewayProbe extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>

  constructor(name: string, args: AppGatewayProbeInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => {
      const props: Record<string, unknown> = {
        protocol: a.protocol,
        path: a.path,
        interval: a.interval ?? 30,
        timeout: a.timeout ?? 30,
        unhealthyThreshold: a.unhealthyThreshold ?? 3,
        pickHostNameFromBackendHttpSettings: a.pickHostNameFromBackendHttpSettings ?? true,
      }
      if (a.host) {
        props.host = a.host
      }
      return { name: a.name, properties: props }
    })

    super(
      provider,
      name,
      {
        connection: pulumi.secret(args.connection),
        gatewayName: args.gatewayName,
        entry,
      },
      { ...opts, customTimeouts: { create: '10m', update: '10m', delete: '10m' } },
    )
  }
}

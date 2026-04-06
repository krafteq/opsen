import * as pulumi from '@pulumi/pulumi'
import { AzureConnection } from '../azure-connection'
import { createSubResourceProvider } from './app-gateway-sub-resource'

export interface AppGatewayBackendPoolInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  /** Backend FQDNs (e.g. Container App or Web App hostnames) */
  fqdns: pulumi.Input<pulumi.Input<string>[]>
}

const provider = createSubResourceProvider({
  arrayProperty: 'backendAddressPools',
  displayName: 'Backend Address Pool',
})

export class AppGatewayBackendPool extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>
  declare public readonly fqdns: pulumi.Output<string[]>

  constructor(name: string, args: AppGatewayBackendPoolInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => ({
      name: a.name,
      properties: {
        backendAddresses: (a.fqdns as string[]).map((fqdn) => ({ fqdn })),
      },
    }))

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

import * as pulumi from '@pulumi/pulumi'
import { AzureConnection } from '../azure-connection'
import { createSubResourceProvider } from './app-gateway-sub-resource'

export interface AppGatewayBackendSettingsInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  port: pulumi.Input<number>
  protocol: pulumi.Input<'Http' | 'Https'>
  /** Resource ID of a custom health probe */
  probeId?: pulumi.Input<string>
  requestTimeout?: pulumi.Input<number>
  /** Pick the host header from the backend target (needed for ACA/WebApp) */
  pickHostNameFromBackendAddress?: pulumi.Input<boolean>
}

const provider = createSubResourceProvider({
  arrayProperty: 'backendHttpSettingsCollection',
  displayName: 'Backend HTTP Settings',
})

export class AppGatewayBackendSettings extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>
  declare public readonly port: pulumi.Output<number>
  declare public readonly protocol: pulumi.Output<string>

  constructor(name: string, args: AppGatewayBackendSettingsInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => {
      const props: Record<string, unknown> = {
        port: a.port,
        protocol: a.protocol,
        requestTimeout: a.requestTimeout ?? 30,
        pickHostNameFromBackendAddress: a.pickHostNameFromBackendAddress ?? true,
      }
      if (a.probeId) {
        props.probe = { id: a.probeId }
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

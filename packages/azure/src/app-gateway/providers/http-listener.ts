import * as pulumi from '@pulumi/pulumi'
import { AzureConnection } from '../azure-connection'
import { createSubResourceProvider } from './app-gateway-sub-resource'

export interface AppGatewayHttpListenerInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  hostName: pulumi.Input<string>
  protocol: pulumi.Input<'Http' | 'Https'>
  /** Resource ID of the frontend IP configuration */
  frontendIpConfigurationId: pulumi.Input<string>
  /** Resource ID of the frontend port */
  frontendPortId: pulumi.Input<string>
  /** Resource ID of the SSL certificate (required for Https) */
  sslCertificateId?: pulumi.Input<string>
}

const provider = createSubResourceProvider({
  arrayProperty: 'httpListeners',
  displayName: 'HTTP Listener',
})

export class AppGatewayHttpListener extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>
  declare public readonly hostName: pulumi.Output<string>
  declare public readonly protocol: pulumi.Output<string>

  constructor(name: string, args: AppGatewayHttpListenerInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => {
      const e: Record<string, unknown> = {
        name: a.name,
        properties: {
          hostName: a.hostName,
          protocol: a.protocol,
          frontendIPConfiguration: { id: a.frontendIpConfigurationId },
          frontendPort: { id: a.frontendPortId },
        },
      }
      if (a.sslCertificateId) {
        ;(e.properties as Record<string, unknown>).sslCertificate = { id: a.sslCertificateId }
      }
      return e
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

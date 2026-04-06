import * as pulumi from '@pulumi/pulumi'
import { AzureConnection } from '../azure-connection'
import { createSubResourceProvider } from './app-gateway-sub-resource'

export interface AppGatewaySslCertificateInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  /** Key Vault secret ID containing the PFX certificate */
  keyVaultSecretId: pulumi.Input<string>
}

const provider = createSubResourceProvider({
  arrayProperty: 'sslCertificates',
  displayName: 'SSL Certificate',
})

export class AppGatewaySslCertificate extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>
  declare public readonly keyVaultSecretId: pulumi.Output<string>

  constructor(name: string, args: AppGatewaySslCertificateInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => ({
      name: a.name,
      properties: {
        keyVaultSecretId: a.keyVaultSecretId,
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

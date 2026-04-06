import * as pulumi from '@pulumi/pulumi'
import { AzureConnection } from '../azure-connection'
import { createSubResourceProvider } from './app-gateway-sub-resource'

export interface AppGatewayRoutingRuleInputs {
  connection: pulumi.Input<AzureConnection>
  gatewayName: pulumi.Input<string>
  name: pulumi.Input<string>
  priority: pulumi.Input<number>
  ruleType?: pulumi.Input<'Basic' | 'PathBasedRouting'>
  /** Resource ID of the HTTP listener */
  httpListenerId: pulumi.Input<string>
  /** Resource ID of the backend address pool */
  backendAddressPoolId: pulumi.Input<string>
  /** Resource ID of the backend HTTP settings */
  backendHttpSettingsId: pulumi.Input<string>
}

const provider = createSubResourceProvider({
  arrayProperty: 'requestRoutingRules',
  displayName: 'Request Routing Rule',
})

export class AppGatewayRoutingRule extends pulumi.dynamic.Resource {
  declare public readonly connection: pulumi.Output<AzureConnection>
  declare public readonly gatewayName: pulumi.Output<string>
  declare public readonly name: pulumi.Output<string>
  declare public readonly priority: pulumi.Output<number>

  constructor(name: string, args: AppGatewayRoutingRuleInputs, opts?: pulumi.CustomResourceOptions) {
    const entry = pulumi.all([args]).apply(([a]) => ({
      name: a.name,
      properties: {
        ruleType: a.ruleType ?? 'Basic',
        priority: a.priority,
        httpListener: { id: a.httpListenerId },
        backendAddressPool: { id: a.backendAddressPoolId },
        backendHttpSettings: { id: a.backendHttpSettingsId },
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

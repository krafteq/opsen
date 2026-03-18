import * as pulumi from '@pulumi/pulumi'
import * as network from '@pulumi/azure-native/network'

export interface CreateAppGatewayArgs {
  resourceGroupName: pulumi.Input<string>
  location?: pulumi.Input<string>
  /** Subnet ID — must be a dedicated subnet for App Gateway */
  subnetId: pulumi.Input<string>
  /** UserAssigned Managed Identity resource ID (for Key Vault access) */
  identityId: pulumi.Input<string>
  /** WAF policy resource ID (optional) */
  wafPolicyId?: pulumi.Input<string>
  skuTier?: 'WAF_v2' | 'Standard_v2'
  minCapacity?: number
  maxCapacity?: number
}

export interface AppGatewayRef {
  gatewayId: pulumi.Output<string>
  gatewayName: pulumi.Output<string>
  publicIpAddress: pulumi.Output<string>
  /** Prefix for building sub-resource IDs: /subscriptions/.../applicationGateways/{name} */
  resourceIdPrefix: pulumi.Output<string>
  frontendIpConfigId: pulumi.Output<string>
  frontendPort443Id: pulumi.Output<string>
}

/**
 * Create a base Application Gateway with WAF_v2 SKU, a public IP,
 * and a placeholder HTTP listener (App GW requires >= 1 listener/rule).
 */
export function createAppGateway(name: string, args: CreateAppGatewayArgs): AppGatewayRef {
  const skuTier = args.skuTier ?? 'WAF_v2'
  const skuName = skuTier === 'WAF_v2' ? 'WAF_v2' : 'Standard_v2'

  const publicIp = new network.PublicIPAddress(`${name}-pip`, {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: 'Standard' },
    publicIPAllocationMethod: 'Static',
  })

  const gw = new network.ApplicationGateway(name, {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    identity: {
      type: network.ResourceIdentityType.UserAssigned,
      userAssignedIdentities: pulumi.output(args.identityId).apply((id) => [id]),
    },
    sku: {
      name: skuName,
      tier: skuTier,
    },
    autoscaleConfiguration: {
      minCapacity: args.minCapacity ?? 0,
      maxCapacity: args.maxCapacity ?? 2,
    },
    gatewayIPConfigurations: [
      {
        name: 'gateway-ip-config',
        subnet: { id: args.subnetId },
      },
    ],
    frontendIPConfigurations: [
      {
        name: 'frontend-ip',
        publicIPAddress: { id: publicIp.id },
      },
    ],
    frontendPorts: [
      { name: 'port-80', port: 80 },
      { name: 'port-443', port: 443 },
    ],
    // Placeholder listener + rule (App GW requires at least one)
    httpListeners: [
      {
        name: 'placeholder-http',
        protocol: network.ApplicationGatewayProtocol.Http,
      },
    ],
    backendAddressPools: [{ name: 'placeholder-pool' }],
    backendHttpSettingsCollection: [
      {
        name: 'placeholder-settings',
        port: 80,
        protocol: network.ApplicationGatewayProtocol.Http,
      },
    ],
    requestRoutingRules: [
      {
        name: 'placeholder-rule',
        ruleType: network.ApplicationGatewayRequestRoutingRuleType.Basic,
        priority: 19999,
      },
    ],
    firewallPolicy: args.wafPolicyId ? { id: args.wafPolicyId } : undefined,
  })

  return {
    gatewayId: gw.id,
    gatewayName: gw.name,
    publicIpAddress: publicIp.ipAddress.apply((ip) => ip ?? ''),
    resourceIdPrefix: gw.id,
    frontendIpConfigId: pulumi.interpolate`${gw.id}/frontendIPConfigurations/frontend-ip`,
    frontendPort443Id: pulumi.interpolate`${gw.id}/frontendPorts/port-443`,
  }
}

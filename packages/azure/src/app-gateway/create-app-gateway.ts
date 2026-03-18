import * as pulumi from '@pulumi/pulumi'
import * as network from '@pulumi/azure-native/network'
import { AzureDeployer, AzureDeployParams } from '../deployer/base'

export interface AppGatewayDeployParams extends AzureDeployParams {
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
 * Deploys a base Application Gateway with WAF_v2 SKU, a public IP,
 * and a placeholder HTTP listener (App GW requires >= 1 listener/rule).
 */
export class AppGatewayDeployer extends AzureDeployer<AppGatewayDeployParams> {
  deploy(): AppGatewayRef {
    const skuTier = this.params.skuTier ?? 'WAF_v2'
    const skuName = skuTier === 'WAF_v2' ? 'WAF_v2' : 'Standard_v2'

    const publicIp = new network.PublicIPAddress(
      `${this.name}-pip`,
      {
        resourceGroupName: this.resourceGroupName,
        location: this.location,
        sku: { name: 'Standard' },
        publicIPAllocationMethod: 'Static',
      },
      this.options(),
    )

    // Build self-referencing sub-resource ID prefix (needed for inline references within the gateway)
    const gwIdPrefix = pulumi.interpolate`/subscriptions/${pulumi
      .output(this.params.subnetId)
      .apply(
        (id) => id.split('/')[2],
      )}/resourceGroups/${this.resourceGroupName}/providers/Microsoft.Network/applicationGateways/${this.name}`

    const gw = new network.ApplicationGateway(
      this.name,
      {
        applicationGatewayName: this.name,
        resourceGroupName: this.resourceGroupName,
        location: this.location,
        identity: {
          type: network.ResourceIdentityType.UserAssigned,
          userAssignedIdentities: pulumi.output(this.params.identityId).apply((id) => [id]),
        },
        sku: {
          name: skuName,
          tier: skuTier,
        },
        autoscaleConfiguration: {
          minCapacity: this.params.minCapacity ?? 0,
          maxCapacity: this.params.maxCapacity ?? 2,
        },
        gatewayIPConfigurations: [
          {
            name: 'gateway-ip-config',
            subnet: { id: this.params.subnetId },
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
            frontendIPConfiguration: { id: pulumi.interpolate`${gwIdPrefix}/frontendIPConfigurations/frontend-ip` },
            frontendPort: { id: pulumi.interpolate`${gwIdPrefix}/frontendPorts/port-80` },
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
            httpListener: { id: pulumi.interpolate`${gwIdPrefix}/httpListeners/placeholder-http` },
            backendAddressPool: { id: pulumi.interpolate`${gwIdPrefix}/backendAddressPools/placeholder-pool` },
            backendHttpSettings: {
              id: pulumi.interpolate`${gwIdPrefix}/backendHttpSettingsCollection/placeholder-settings`,
            },
          },
        ],
        firewallPolicy: this.params.wafPolicyId ? { id: this.params.wafPolicyId } : undefined,
      },
      this.options(),
    )

    return {
      gatewayId: gw.id,
      gatewayName: gw.name,
      publicIpAddress: publicIp.ipAddress.apply((ip) => ip ?? ''),
      resourceIdPrefix: gw.id,
      frontendIpConfigId: pulumi.interpolate`${gw.id}/frontendIPConfigurations/frontend-ip`,
      frontendPort443Id: pulumi.interpolate`${gw.id}/frontendPorts/port-443`,
    }
  }
}

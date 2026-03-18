/// <reference path="../global.d.ts" />
import * as azure from '@pulumi/azure-native'
import * as pulumi from '@pulumi/pulumi'

export interface AzureDeployParams {
  /** Unique name for this Azure deployment context (used for provider naming) */
  name: string
  /** Resource group name */
  resourceGroupName: pulumi.Input<string>
  /** Azure region */
  location?: pulumi.Input<string>
  /** Explicit Azure Native provider config. If omitted, a provider is created and cached by name. */
  providerConfig?: {
    subscriptionId?: pulumi.Input<string>
    tenantId?: pulumi.Input<string>
    clientId?: pulumi.Input<string>
    clientSecret?: pulumi.Input<string>
  }
}

if (!global.AZURE_PROVIDERS_LOOKUP) global.AZURE_PROVIDERS_LOOKUP = {}

/**
 * Base class for Azure deployers.
 *
 * Manages a shared Azure Native provider keyed by `name`, so all deployers
 * targeting the same Azure context reuse one provider instance.
 * Provides `options()` helper to inject the provider into Pulumi resource options.
 */
export class AzureDeployer<TParams extends AzureDeployParams = AzureDeployParams> {
  protected readonly provider: azure.Provider
  protected readonly name: string
  protected readonly resourceGroupName: pulumi.Input<string>
  protected readonly location: pulumi.Input<string> | undefined

  public constructor(protected readonly params: TParams) {
    this.name = params.name
    this.resourceGroupName = params.resourceGroupName
    this.location = params.location

    this.provider =
      AZURE_PROVIDERS_LOOKUP[params.name] ??
      (AZURE_PROVIDERS_LOOKUP[params.name] = new azure.Provider(params.name, {
        ...(params.providerConfig ?? {}),
      }))
  }

  /**
   * Returns Pulumi resource options with the Azure provider injected.
   * Merges with any provided opts, adds provider to dependsOn.
   */
  protected options(opts?: pulumi.CustomResourceOptions): pulumi.CustomResourceOptions {
    const result = opts ? { ...opts } : {}

    if (!result.provider) result.provider = this.provider

    if (result.dependsOn)
      result.dependsOn = pulumi
        .output(result.dependsOn)
        .apply((x) => (Array.isArray(x) ? [...x, this.provider] : [x, this.provider]))
    else result.dependsOn = this.provider

    return result
  }
}

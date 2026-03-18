import * as azure from '@pulumi/azure-native'

declare global {
  var AZURE_PROVIDERS_LOOKUP: Record<string, azure.Provider>
}

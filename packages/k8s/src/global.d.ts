import * as k8s from '@pulumi/kubernetes'

declare global {
  var PROVIDERS_LOOKUP: Record<string, k8s.Provider>
}

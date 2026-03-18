# @opsen/docker

## 0.1.1

### Patch Changes

- a8cb2c7: Move runtime-specific types from @opsen/platform to their respective packages (AzureRuntime → @opsen/azure, DockerRuntime → @opsen/docker, KubernetesRuntime → @opsen/k8s). Platform is now standalone with no knowledge of specific runtimes. Also replace `import * as azure from '@pulumi/azure-native'` with targeted submodule imports across all Azure files.

# @opsen/azure

## 0.3.0

### Minor Changes

- 98d8ae3: Add secret env vars and secret files support to the Workload type system

  Introduces `SecretValue` and `SecretRef` types for env vars and file content, allowing runtimes to use their native secret mechanisms (K8s Secrets, ACA secrets, Azure Key Vault references). Plain string env vars and files continue to work unchanged.

### Patch Changes

- Updated dependencies [98d8ae3]
  - @opsen/platform@0.3.0

## 0.2.1

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.
- bc630fd: Fix published packages being unusable from npm. Replace `file:` inter-workspace references with pnpm `workspace:^` protocol so dependencies resolve to proper version ranges when published. Add `prepack` script to cert-renewer to ensure `azure-function.zip` is included in the tarball. Add `go/out` to agent `files` array to override `.gitignore` and include the compiled Go binary.
- Updated dependencies [2fa5204]
- Updated dependencies [bc630fd]
  - @opsen/platform@0.2.1
  - @opsen/cert-renewer@0.2.1

## 0.2.0

### Minor Changes

- a8cb2c7: Add Application Gateway WAF integration with dynamic sub-resource providers. Endpoints with `_az.waf: true` are automatically routed through App Gateway with ACME TLS certificates via Key Vault. Includes AppGatewayDeployer, six dynamic providers (listener, pool, settings, rule, probe, ssl-cert) with etag-based optimistic concurrency, CertRenewalFunctionDeployer and CertRenewalJobDeployer for automated certificate renewal. All deployers extend AzureDeployer for shared provider management. App Gateway sub-resources use sequential dependsOn chains to prevent concurrent PUT failures. ACME certificate provider handles Key Vault soft-delete recovery. WAF endpoints skip direct custom domain binding (traffic routes through App Gateway). WebAppDeployer gains Application Insights support.
- a8cb2c7: Add WebApp runtime deployer (AzureWebAppRuntimeDeployer) as a second Azure deployment option alongside Container Apps. Includes buildWebAppSpec building block, WebAppDeployer, Key Vault secret references, Azure Files storage mounts, and custom hostname binding.

### Patch Changes

- a8cb2c7: Move runtime-specific types from @opsen/platform to their respective packages (AzureRuntime → @opsen/azure, DockerRuntime → @opsen/docker, KubernetesRuntime → @opsen/k8s). Platform is now standalone with no knowledge of specific runtimes. Also replace `import * as azure from '@pulumi/azure-native'` with targeted submodule imports across all Azure files.

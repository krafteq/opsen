# @opsen/docker

## 0.3.0

### Minor Changes

- 66d3df7: Add an opt-in `backendProtocol` flag on Caddy ingress routes so gRPC backends are reachable.

  `@opsen/docker` gains `endpoints[].ingress._docker.backendProtocol` (`'http' | 'h2c'`, default `'http'`), carried through `IngressTarget` into both Caddyfile generators. `@opsen/agent` gains `IngressRouteArgs.backendProtocol`, sent to the agent as `backend_protocol` and honoured by the Caddy and Traefik drivers.

  When set to `'h2c'` the upstream is emitted as `h2c://host:port`, so Caddy (and Traefik) speak HTTP/2 cleartext to the container instead of downgrading to HTTP/1.1. Routes that do not set the field emit byte-identical configuration to before.

  `'h2c'` combined with a path prefix is rejected — Caddy's `handle_path` strips the matched prefix, which corrupts absolute gRPC method paths. The TypeScript generators throw and the agent returns 400. Traefik's `PathPrefix` does not strip, so the combination remains legal there.

## 0.2.1

### Patch Changes

- Updated dependencies [0d8136d]
  - @opsen/platform@0.4.0

## 0.2.0

### Minor Changes

- 98d8ae3: Add secret env vars and secret files support to the Workload type system

  Introduces `SecretValue` and `SecretRef` types for env vars and file content, allowing runtimes to use their native secret mechanisms (K8s Secrets, ACA secrets, Azure Key Vault references). Plain string env vars and files continue to work unchanged.

### Patch Changes

- Updated dependencies [98d8ae3]
  - @opsen/platform@0.3.0

## 0.1.2

### Patch Changes

- 2fa5204: Fix CI build failures and resolve Dependabot security alerts. Add `src` to package `files` field for correct pnpm `file:` dependency resolution during clean builds. Pin TypeScript to 5.8.x and unify `@pulumi/pulumi` version to avoid type mismatches. Update `@eslint/json`, `@eslint/markdown`, and add pnpm overrides for `flatted` and `minimatch` vulnerabilities.
- bc630fd: Fix published packages being unusable from npm. Replace `file:` inter-workspace references with pnpm `workspace:^` protocol so dependencies resolve to proper version ranges when published. Add `prepack` script to cert-renewer to ensure `azure-function.zip` is included in the tarball. Add `go/out` to agent `files` array to override `.gitignore` and include the compiled Go binary.
- Updated dependencies [2fa5204]
  - @opsen/platform@0.2.1

## 0.1.1

### Patch Changes

- a8cb2c7: Move runtime-specific types from @opsen/platform to their respective packages (AzureRuntime → @opsen/azure, DockerRuntime → @opsen/docker, KubernetesRuntime → @opsen/k8s). Platform is now standalone with no knowledge of specific runtimes. Also replace `import * as azure from '@pulumi/azure-native'` with targeted submodule imports across all Azure files.

---
name: vitest-test-patterns
description: Patterns for writing comprehensive Vitest test suites in TypeScript library projects. Covers shared test utilities, vi.mock for module mocking, Pulumi resource mocking, fixture directories, and testing deployer/type-system code. Tier - generic.
user-invokable: false
---

# Vitest Test Patterns

## Goal

Establish reusable patterns for writing comprehensive test suites with Vitest in opsen's TypeScript library monorepo.

## Shared Test Utilities

Create `packages/<pkg>/src/__test-utils__/` with reusable helpers:

```ts
// __test-utils__/mock-deployer.ts
import { vi } from 'vitest'
import type { RuntimeDeployer } from '@opsen/platform'

export class MockRuntimeDeployer implements RuntimeDeployer<any> {
  runtimeKind = 'mock'
  deploy = vi.fn<RuntimeDeployer<any>['deploy']>()
}

// Factory helpers with sensible defaults
export function createWorkload(overrides: Partial<Workload<any>> = {}): Workload<any> {
  return {
    image: 'node:22-alpine',
    processes: {
      web: { ports: { http: { port: 3000, protocol: 'http' } } },
    },
    ...overrides,
  }
}

export function createMetadata(name = 'test-app'): WorkloadMetadata {
  return { name }
}
```

**Key pattern:** Use `vi.fn<InterfaceType['methodName']>()` for type-safe mock methods.

## Module Mocking with vi.mock

### Mocking a dependency with shared state

When the SUT creates its own instance of a dependency internally, mock the module and use shared variables to control behavior:

```ts
const mockDeploy = vi.fn()

vi.mock('./deployer/container-app.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./deployer/container-app.js')>()
  return {
    ...original,
    ContainerAppDeployer: vi.fn().mockImplementation(() => ({
      deploy: mockDeploy,
    })),
  }
})
```

### Gotcha: Shared state across mock calls

When mocking `update(fn)` where `fn` mutates state, use a **shared state object** so mutations from one call are visible to the next:

```ts
// WRONG — each call gets a fresh object, mutations are lost
mockUpdate.mockImplementation(async (fn) => {
  fn(new State()) // ← mutations lost between calls
})

// RIGHT — shared state preserves mutations across calls
let sharedState = new State()
mockUpdate.mockImplementation(async (fn) => {
  fn(sharedState)
})
```

## Mocking Pulumi Resources

Opsen packages depend heavily on `@pulumi/pulumi`. For unit tests that don't need a real Pulumi engine:

```ts
// Mock pulumi.output to return unwrapped values
vi.mock('@pulumi/pulumi', async () => {
  return {
    output: (val: any) => ({
      apply: (fn: any) => fn(val),
    }),
    all: (val: any) => ({
      apply: (fn: any) => fn(Array.isArray(val) ? val : Object.fromEntries(Object.entries(val))),
    }),
    interpolate: (strings: TemplateStringsArray, ...values: any[]) =>
      strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), ''),
  }
})
```

## Static Fixture Directories

For filesystem-dependent tests, use static fixture dirs checked into the repo:

```text
packages/<pkg>/src/__fixtures__/
  simple-workload/        # Happy path
    workload.ts
  multi-process/          # Multiple processes
    workload.ts
  with-volumes/           # Volume mounts
    workload.ts
```

Reference fixtures with `import.meta.dirname`:

```ts
const FIXTURES_DIR = resolve(import.meta.dirname, '__fixtures__')

it('should deploy workload', async () => {
  const workload = await import(join(FIXTURES_DIR, 'simple-workload/workload.ts'))
  const result = deployer.deploy(workload.default, { name: 'test' })
  expect(result).toBeDefined()
})
```

## Extract Pure Functions for Testability

When a class has complex private logic, extract it as an **exported pure function**:

```ts
// Before: private method, untestable
class WorkloadDeployer {
  private mapProbe(x?: Probe) {
    /* complex mapping */
  }
}

// After: exported pure function + thin delegate
export function mapProbeToK8s(x?: Probe): k8s.types.input.core.v1.Probe | undefined {
  /* same logic, now directly testable */
}

class WorkloadDeployer {
  private mapProbe(x?: Probe) {
    return mapProbeToK8s(x)
  }
}
```

Test the exported function directly:

```ts
import { mapProbeToK8s } from './workload-deployer.js'

it('should map exec probe', () => {
  const probe = mapProbeToK8s({
    action: { type: 'exec', cmd: ['healthcheck'] },
    periodSeconds: 10,
  })
  expect(probe?.exec?.command).toEqual(['healthcheck'])
  expect(probe?.periodSeconds).toBe(10)
})
```

## Testing the Facts System

`@opsen/infra` facts pool is a good candidate for pure unit tests:

```ts
import { FactsPool } from './facts-pool.js'

it('should find fact by kind and name', () => {
  const pool = new FactsPool([
    { kind: 'workload', metadata: { name: 'api' }, spec: { image: 'node:22' } },
    { kind: 'workload', metadata: { name: 'worker' }, spec: { image: 'python:3' } },
  ])
  const fact = pool.get('workload', 'api')
  expect(fact?.spec.image).toBe('node:22')
})

it('should filter by labels', () => {
  const pool = new FactsPool([
    { kind: 'db', metadata: { name: 'pg', labels: { env: 'prod' } }, spec: {} },
    { kind: 'db', metadata: { name: 'redis', labels: { env: 'dev' } }, spec: {} },
  ])
  const results = pool.filter('db', { env: 'prod' })
  expect(results).toHaveLength(1)
  expect(results[0].metadata.name).toBe('pg')
})
```

## Testing Deployer Output

For runtime deployer tests, verify the structure of deployed resources without a real cloud/cluster:

```ts
it('should create one container per process', () => {
  const workload = createWorkload({
    processes: {
      web: { ports: { http: { port: 3000, protocol: 'http' } } },
      worker: { cmd: ['node', 'worker.js'] },
    },
  })
  const result = deployer.deploy(workload, createMetadata())
  expect(Object.keys(result.processes)).toEqual(['web', 'worker'])
})
```

## Gotchas

- **Pulumi Outputs:** In tests, `pulumi.output(x).apply(fn)` is async. Either mock pulumi (see above) or use `pulumi.all([...]).apply()` patterns in assertions.
- **`vi.mock` hoisting:** `vi.mock()` calls are hoisted to the top of the file. Variables referenced inside the factory must be declared with `vi.fn()` at module scope — they can't reference `let` variables from `beforeEach`.
- **Cross-package imports:** When testing packages that depend on other `@opsen/*` packages, the `file:` dependencies resolve correctly in tests — Vitest follows the same resolution as the TypeScript compiler.
- **Module-level singletons:** These persist across tests within a file. Concurrent tests that share state may interfere. Prefer sequential operations in tests or mock the singleton.

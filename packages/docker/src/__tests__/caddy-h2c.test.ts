import { describe, it, expect, beforeAll } from 'vitest'
import * as docker from '@pulumi/docker'
import * as pulumi from '@pulumi/pulumi'
import type { Workload } from '@opsen/platform'
import { generateCaddyfile } from '../building-blocks/caddy'
import { CaddyIngressDeployer } from '../ingress/caddy'
import { DockerWorkloadDeployer, type IngressTarget } from '../workload/workload-deployer'
import type { DockerRuntime } from '../runtime'

/** Every `reverse_proxy` line of a Caddyfile, indentation included. */
function reverseProxyLines(caddyfile: string): string[] {
  return caddyfile.split('\n').filter((line) => line.trim().startsWith('reverse_proxy'))
}

function resolveOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    output.apply((value) => {
      resolve(value)
      return value
    })
  })
}

let network: docker.Network

beforeAll(() => {
  pulumi.runtime.setMocks(
    {
      newResource: (args: pulumi.runtime.MockResourceArgs) => ({
        id: `${args.name}-id`,
        state: { name: args.name, ...args.inputs },
      }),
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    },
    'opsen-docker-test',
    'test',
    false,
  )

  network = new docker.Network('test-net', { name: 'test-net' })
})

describe('CaddyIngressDeployer.generateCaddyfile', () => {
  // The two inputs below differ only in `backendProtocol`.
  const base: IngressTarget = {
    endpointName: 'grpc',
    containerName: 'app',
    containerPort: 8080,
    hosts: ['app.example.com'],
    path: '/',
    enableCors: false,
  }

  const deployer = () => new CaddyIngressDeployer({ name: 'test', network })

  it('emits a bare upstream when the field is absent', () => {
    expect(reverseProxyLines(deployer().generateCaddyfile([base]))).toEqual(['  reverse_proxy app:8080'])
  })

  it("emits an h2c:// upstream when the field is 'h2c'", () => {
    const h2c: IngressTarget = { ...base, backendProtocol: 'h2c' }
    expect(reverseProxyLines(deployer().generateCaddyfile([h2c]))).toEqual(['  reverse_proxy h2c://app:8080'])
  })

  it("treats an explicit 'http' as byte-identical to the default", () => {
    const explicit: IngressTarget = { ...base, backendProtocol: 'http' }
    expect(deployer().generateCaddyfile([explicit])).toBe(deployer().generateCaddyfile([base]))
  })

  it('throws when h2c is combined with a path prefix, naming the endpoint', () => {
    const h2cWithPath: IngressTarget = { ...base, backendProtocol: 'h2c', path: '/api' }
    expect(() => deployer().generateCaddyfile([h2cWithPath])).toThrow(/grpc/)
    expect(() => deployer().generateCaddyfile([h2cWithPath])).toThrow(/h2c/)
  })
})

describe('DockerWorkloadDeployer → generateCaddyfile wiring', () => {
  function grpcWorkload(path?: string): Workload<DockerRuntime> {
    return {
      image: 'example/grpc-app',
      processes: {
        api: {
          ports: { grpc: { port: 8080, protocol: 'grpc' } },
        },
      },
      endpoints: {
        grpc: {
          backend: { process: 'api', port: 'grpc' },
          ingress: {
            hosts: ['app.example.com'],
            ...(path ? { path } : {}),
            _docker: { backendProtocol: 'h2c' },
          },
        },
      },
    }
  }

  it('carries backendProtocol from the endpoint through to the emitted Caddyfile', async () => {
    const deployer = new DockerWorkloadDeployer({ network })

    const deployed = await resolveOutput(deployer.deploy(grpcWorkload(), { name: 'myapp' }))

    // Feed the deployer's own output into the generator — no hand-built targets.
    const caddyfile = generateCaddyfile(deployed.ingressTargets)

    expect(reverseProxyLines(caddyfile)).toEqual(['  reverse_proxy h2c://myapp-api:8080'])
  })

  it('leaves the upstream bare when the endpoint does not opt in', async () => {
    const deployer = new DockerWorkloadDeployer({ network })

    const workload: Workload<DockerRuntime> = {
      image: 'example/http-app',
      processes: { api: { ports: { http: { port: 8080, protocol: 'http' } } } },
      endpoints: {
        http: {
          backend: { process: 'api', port: 'http' },
          ingress: { hosts: ['app.example.com'] },
        },
      },
    }

    const deployed = await resolveOutput(deployer.deploy(workload, { name: 'plainapp' }))

    expect(deployed.ingressTargets[0]?.backendProtocol).toBeUndefined()
    expect(reverseProxyLines(generateCaddyfile(deployed.ingressTargets))).toEqual(['  reverse_proxy plainapp-api:8080'])
  })

  it('rejects an h2c endpoint that also declares a path prefix', async () => {
    const deployer = new DockerWorkloadDeployer({ network })

    const deployed = await resolveOutput(deployer.deploy(grpcWorkload('/api'), { name: 'pathapp' }))

    expect(() => generateCaddyfile(deployed.ingressTargets)).toThrow(/grpc/)
  })
})

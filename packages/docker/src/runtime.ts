import { DefineRuntime } from '@opsen/platform'

export type DockerRuntime = DefineRuntime<
  '_docker',
  {
    volume: {
      _docker: {
        driver?: string
        driverOpts?: Record<string, string>
      }
    }
    ingress: {
      _docker: {
        acmeEmail?: string
        /**
         * Protocol Caddy speaks to the backend. Defaults to `'http'` (HTTP/1.1),
         * which is Caddy's own default upstream transport. Set to `'h2c'` for
         * gRPC backends — the upstream is emitted as `h2c://host:port` so the
         * request reaches the container over HTTP/2 cleartext instead of being
         * downgraded to HTTP/1.1.
         *
         * `'h2c'` cannot be combined with an ingress `path` other than `/`:
         * Caddy's `handle_path` strips the matched prefix, which corrupts the
         * absolute `/package.Service/Method` paths gRPC requires. Caddyfile
         * generation throws in that case.
         */
        backendProtocol?: 'http' | 'h2c'
      }
    }
    workload: {
      _docker: {
        restart?: 'no' | 'always' | 'on-failure' | 'unless-stopped'
        memoryMb?: number
        cpus?: number
      }
    }
    process: {
      _docker: {
        restart?: 'no' | 'always' | 'on-failure' | 'unless-stopped'
        memoryMb?: number
        cpus?: number
        networkMode?: string
      }
    }
  }
>

---
'@opsen/docker': minor
'@opsen/agent': minor
---

Add an opt-in `backendProtocol` flag on Caddy ingress routes so gRPC backends are reachable.

`@opsen/docker` gains `endpoints[].ingress._docker.backendProtocol` (`'http' | 'h2c'`, default `'http'`), carried through `IngressTarget` into both Caddyfile generators. `@opsen/agent` gains `IngressRouteArgs.backendProtocol`, sent to the agent as `backend_protocol` and honoured by the Caddy and Traefik drivers.

When set to `'h2c'` the upstream is emitted as `h2c://host:port`, so Caddy (and Traefik) speak HTTP/2 cleartext to the container instead of downgrading to HTTP/1.1. Routes that do not set the field emit byte-identical configuration to before.

`'h2c'` combined with a path prefix is rejected — Caddy's `handle_path` strips the matched prefix, which corrupts absolute gRPC method paths. The TypeScript generators throw and the agent returns 400. Traefik's `PathPrefix` does not strip, so the combination remains legal there.

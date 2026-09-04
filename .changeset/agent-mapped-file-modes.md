---
'@opsen/agent': patch
---

Make bind-mounted project files readable by hardened non-root Compose services (OPSEN-6).

Files delivered through the Compose deploy `files` map (app-platform `MappedFile`, bind-mounted as `./files/<process>/<path>:<path>:ro`) were written `opsen-agent:opsen-agent 0640` inside `0750` directories. `hardenCompose` runs every service as a non-root `default_user` with `cap_drop: ALL`, so the container had neither owner, group nor "other" read permission and no `CAP_DAC_OVERRIDE`: every mapped file was unreadable by a non-elevated service (`template not found or not readable: /etc/grm/config.toml.tmpl`), and the only workaround was `_docker.elevated: true`, which defeats the non-root hardening.

The agent (non-root itself, so it cannot chown to the service uid) now writes the project tree under a fixed mode contract, pinned with an explicit chmod so a redeploy over files written by an older version repairs them: non-compose project files `0644` and every directory below the project directory `0755`, while the per-client / per-project directories stay `0750` and the compose file (never bind-mounted, carries env secrets) stays `0640`. The reconciler re-applies the contract to existing project trees on its next policy-hash-driven redeploy, so already-deployed projects self-heal without a client-side redeploy. The contract is documented in `spec.md` under "Project File Ownership and Modes".

Because Docker resolves a bind-mount source as root, world-readable project files would have been reachable from _another_ client's container through a bind mount of `deployments/<client>/<project>/files` (absolute or `../../…`): the default deny list does not cover the deployments directory and `allowed_host_paths` is allow-all when unset. Bind-mount sources are therefore now resolved (relative to the project directory) and confined before anything is written: a source below the deploying project's own directory is allowed and must be read-only, a source that overlaps the agent deployments directory anywhere else is rejected, and only the remainder is matched — resolved, on path boundaries — against `deny.host_paths` and `allowed_host_paths`. That also closes `../..`-style traversal past the deny list, `.env`-interpolated (`${VAR}`) and `~`-relative sources, and `driver_opts` bind volumes, none of which the validator resolved before. Newly rejected as a consequence: a writable bind mount of the project tree (use a named volume — the ownership init sidecar makes it writable for a non-root service) and the project directory `.` itself as a source. The rules are documented in `spec.md` under "Bind-Mount Source Confinement".

The project name in the deploy URL is now restricted to `[A-Za-z0-9][A-Za-z0-9_-]*`; a percent-encoded `..` segment previously escaped the client directory.

Consumers that set `_docker.elevated: true` only to make mapped files readable can drop it once this version is installed on their VMs.

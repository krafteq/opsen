---
'@opsen/agent': patch
---

Make bind-mounted project files readable by hardened non-root Compose services (OPSEN-6).

Files delivered through the Compose deploy `files` map (app-platform `MappedFile`, bind-mounted as `./files/<process>/<path>:<path>:ro`) were written `opsen-agent:opsen-agent 0640` inside `0750` directories. `hardenCompose` runs every service as a non-root `default_user` with `cap_drop: ALL`, so the container had neither owner, group nor "other" read permission and no `CAP_DAC_OVERRIDE`: every mapped file was unreadable by a non-elevated service (`template not found or not readable: /etc/grm/config.toml.tmpl`), and the only workaround was `_docker.elevated: true`, which defeats the non-root hardening.

The agent (non-root itself, so it cannot chown to the service uid) now writes the project tree under a fixed mode contract, pinned with an explicit chmod so a redeploy over files written by an older version repairs them: non-compose project files `0644` and every directory below the project directory `0755`, while the per-client / per-project directories stay `0750` and the compose file (never bind-mounted, carries env secrets) stays `0640`. The reconciler re-applies the contract to existing project trees on its next policy-hash-driven redeploy, so already-deployed projects self-heal without a client-side redeploy. The contract is documented in `spec.md` under "Project File Ownership and Modes".

Consumers that set `_docker.elevated: true` only to make mapped files readable can drop it once this version is installed on their VMs.

---
'@opsen/agent': minor
---

Auto-fix named-volume ownership for hardened non-root Compose services. The agent forces a non-root `user:` and a read-only rootfs onto every service, but Docker initializes a fresh named volume as `root:root 0755`, so the injected user got `EACCES` on its own declared volume/cache — the only workaround was running the long-lived, network-exposed container as root (`elevated`/`privileged`).

`hardenCompose` now injects an ephemeral `{service}-opsen-chown-init` sidecar for each hardened non-root service that mounts writable named volumes. The sidecar runs as `user: "0:0"` with `cap_drop: [ALL]` + `cap_add: [CHOWN, DAC_READ_SEARCH]`, `chown -R`s the mounts to the service's uid:gid, and exits before the app starts (wired via `depends_on: { condition: service_completed_successfully }`). It is built after the per-service hardening pass so the global `cap_drop: ALL` and read-only rootfs don't strip the ownership-fixup capabilities / block the chown. Bind mounts, anonymous volumes, read-only mounts, and name-based (non-numeric) users are skipped; re-hardening is idempotent.

The sidecar image is configurable via `global_hardening.chown_init_image` (defaults to `busybox`), exposed through the Pulumi installer as `globalHardening.chownInitImage` for pointing at an internal-registry mirror on air-gapped/registry-restricted hosts. Existing deployments migrate automatically via a policy-hash bump. Running non-root and mounting a writable volume are no longer mutually exclusive on the Compose backend, removing the need for `elevated`/`privileged` as an ownership workaround. (Throwaway caches such as a Chromium crashpad dir should instead be emitted as `tmpfs:` by upstream codegen.)

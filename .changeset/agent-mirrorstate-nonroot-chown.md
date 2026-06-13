---
'@opsen/agent': patch
---

Fix `AgentInstaller` client-policy `MirrorState` failing with `Permission denied` (`status 2`) on non-root SSH targets.

Every file the installer writes goes through `command.remote.Command` wrapped in `sudo`, except client policies — those are synced by `MirrorState`, which uploads over plain SFTP **as the SSH user with no privilege escalation**. The installer created `/etc/opsen-agent` as root and never prepared `/var/lib/mirror-state`, so on a host reached as a non-root sudo user (e.g. `connection.user = 'deploy'`) the SFTP `mkdir` into the staging dir and the `clients` symlink replacement in the root-owned parent both failed.

The setup step now mirrors `ComposeProject`'s prep: it creates `/var/lib/mirror-state` and chowns it plus the `/etc/opsen-agent` parent (non-recursively) to the connection user, so `MirrorState`'s unprivileged writes succeed. Files inside `/etc/opsen-agent` (`agent.yaml`, `*.pem`) keep their `opsen-agent` ownership, and the change is a no-op when connecting as root.

This was latent because `MirrorState` only writes when rendered content changes; it surfaced the first time a client policy's bytes actually changed on a `deploy`-user target.

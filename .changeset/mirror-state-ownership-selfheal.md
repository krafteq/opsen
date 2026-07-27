---
'@opsen/docker-compose': patch
---

fix(docker-compose): self-heal `/var/lib/mirror-state` ownership before each mirror write

The mirror-state and project setup commands were create-only, so if the staging
directory's ownership drifted to `root:root` (e.g. left behind by an earlier
root-run deploy), the `MirrorState` sync — which runs as the connection user over
SFTP and cannot `chown` — failed with "Permission denied" and required a manual
`sudo chown <user>:<user> /var/lib/mirror-state` to unblock. The idempotent
`mkdir -p` + `chown` now re-runs via `triggers: [mirrorFiles]`, i.e. on every file
change, right before the mirror writes — so ownership drift self-heals with no
manual action.

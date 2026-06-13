---
'@opsen/agent': patch
---

Fix `AgentInstaller` silently uploading an empty agent binary, leaving a crash-looping agent (`status=203/EXEC`) while `pulumi up` reports success.

The binary is built locally into `<pkg>/go/out` (inside `node_modules`) and uploaded with `CopyToRemote`. A routine `rm -rf node_modules && npm install` deletes the artifact; the installer then writes a 0-byte placeholder (needed to satisfy `FileAsset`'s registration-time hashing), and if that empty file gets promoted nothing validated it — `chmod +x` and `systemctl start` both "succeed" and the agent dies on `Exec format error`, surfacing only later as `ECONNREFUSED :8443` from a downstream deployer.

The installer now validates the artifact at two points: the build step asserts the freshly built binary is non-empty (`test -s`) before trusting its hash, and the promotion step refuses to install a 0-byte upload **before** clobbering a known-good binary, then runs `opsen-agent --version` to confirm the promoted binary actually executes on the host. A bad artifact now fails the apply loudly instead of shipping a dead agent.

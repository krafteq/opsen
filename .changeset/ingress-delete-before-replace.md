---
'@opsen/agent': patch
---

Fix `IngressRoutes` replacement (app rename / agent move) failing with a 500 `failed to reload ingress` when the new app keeps the same host.

The Caddy ingress driver writes one config file per app (`{client}--{app}.conf`) and the agent loads every file on reload. Caddy rejects a config that has two server blocks for the same site address, so two apps can never claim the same host simultaneously. Under Pulumi's default create-before-delete replacement, the renamed app's routes were written (claiming the host) while the old app's file still existed, and the reload triggered by the create 500'd before the old app was deleted.

The `IngressRoutes` provider's `diff` now returns `deleteBeforeReplace: true` whenever a replacement is triggered, so the old app's routes are removed before the new app's are written, eliminating the transient host collision.

Note: this only orders replacements of the _same_ Pulumi resource. If a rename also changes the Pulumi resource name (URN), Pulumi treats it as an independent create + delete and this flag does not apply — add `aliases: [{ name: '<old-name>' }]` to the resource so it is seen as a replacement.

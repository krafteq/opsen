---
'@opsen/platform': minor
'@opsen/agent': minor
'@opsen/powerdns': minor
'@opsen/docker-compose': minor
'@opsen/k8s-ops': minor
---

Wrap all resource Args fields with `pulumi.Input<>` for consumer flexibility. Arrays and Records are double-wrapped (e.g. `pulumi.Input<pulumi.Input<string>[]>`). Consumers can now pass Outputs directly without `.apply()` wrappers.

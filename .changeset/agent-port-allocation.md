---
'@opsen/agent': minor
---

feat(agent): add host port allocation for compose expose and tmpfs merge

The compose role now manages host port allocation from a configured `port_range`. Services declare container ports via `expose:` in their compose file, and the agent allocates host ports bound to the client's `ingress_bind_address`. Port mappings are returned in the deploy response for ingress wiring. Tmpfs handling now merges client entries with global defaults instead of overwriting.

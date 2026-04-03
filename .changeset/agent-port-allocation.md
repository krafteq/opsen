---
'@opsen/agent': minor
---

feat(agent): add host port allocation, tmpfs merge, and MirrorState client policies

- Compose role manages host port allocation from a configured `port_range`. Services declare container ports via `expose:`, and the agent allocates host ports bound to the client's `ingress_bind_address`. Port mappings are returned in the deploy response.
- Tmpfs handling merges client entries with global defaults instead of overwriting.
- Client policy files are now managed via MirrorState (from @opsen/docker-compose) instead of individual remote commands, ensuring stale policy files are cleaned up when clients are removed.

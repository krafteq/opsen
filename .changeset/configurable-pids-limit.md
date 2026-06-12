---
'@opsen/agent': minor
---

Make compose container PID limits configurable. `per_container.default_pids` now controls the applied default limit, service-level `pids_limit` is preserved when valid, and `per_container.max_pids` is now a cap instead of the forced applied value.

Operators that used `max_pids` to raise the applied limit should move that value to `default_pids`. If `max_pids` is below the default PID limit of 256, also set `per_container.default_pids` at or below the cap.

---
'@opsen/agent': minor
---

Isolate compose project networks per project. Previously all compose projects belonging to one client shared a single `opsen-{client}-internal` network, so services in different projects could reach each other by docker DNS. Each project now gets its own `opsen-{client}-{project}-internal` network. Cross-project communication must go through ingress.

Existing deployments are migrated automatically: the policy hash is bumped so the reconciler redeploys each project once onto its own network, and the legacy shared network is removed best-effort after each redeploy.

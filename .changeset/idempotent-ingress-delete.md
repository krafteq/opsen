---
'@opsen/agent': patch
---

Make ingress delete operations idempotent — no longer returns 500 when config files don't exist or were already deleted. Also cleans up legacy pre-app-scoping config files (`{client}.conf`) during delete and includes them in MaxRoutes validation.

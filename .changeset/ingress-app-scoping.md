---
'@opsen/agent': minor
---

Add app-scoped ingress routes. Each Pulumi project can now independently manage its own routes within a shared client connection by specifying an `app` name. New API endpoints: `PUT/GET /v1/ingress/apps/{app}/routes` and `DELETE /v1/ingress/apps/{app}`. Legacy endpoints remain backwards-compatible using `_default` app. MaxRoutes policy is enforced across all apps for the client.

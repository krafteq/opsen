---
'@opsen/agent': patch
---

Support rotating an existing database owner's password through `PATCH /v1/db/databases/{name}` with `owner.password`, alone or alongside limits. Validate the client's password policy, preserve owner identity, and apply PostgreSQL changes transactionally so failures cannot report a successful rotation. Passwords are not persisted in agent state or included in responses or agent logs.

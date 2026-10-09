---
'@opsen/agent': patch
---

Fix `GET /v1/compose/projects/{project}` for multi-container projects. Compose ≥2.21 prints `ps --format json` as one object per line, which the agent embedded verbatim, so the response failed to encode and returned HTTP 200 with an empty body. The agent now normalizes the output to a JSON array (also accepting the legacy array form), reads stdout only so compose warnings cannot corrupt it, and reports `status: "unknown"` with no containers when the output is unparseable.

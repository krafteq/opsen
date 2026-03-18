---
'@opsen/agent': patch
---

Include compiled Go binary in published package. Add `prepack` script to cross-compile `opsen-agent` for linux/amd64 before packing, and add Go setup to the release CI workflow.

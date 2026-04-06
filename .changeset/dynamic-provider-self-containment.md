---
'@opsen/agent': patch
'@opsen/azure': patch
'@opsen/docker-compose': patch
---

fix: inline all local module dependencies into dynamic provider files

Pulumi serializes dynamic provider closures into state, including absolute paths
to every local module referenced in the closure chain. This caused failures when
the project was built in a different directory or files were moved.

All dynamic provider files are now fully self-contained — helper functions,
interfaces, and constants are inlined directly. Only 3rd-party npm packages and
Node.js built-in imports remain.

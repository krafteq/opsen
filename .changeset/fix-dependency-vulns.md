---
'@opsen/cert-renewer': patch
'@opsen/agent': patch
---

Fix dependency vulnerabilities: upgrade node-forge to 1.4.0 (4 high CVEs in cert chain verification, Ed25519/RSA signature forgery, DoS) and Go toolchain to 1.24.13 (14 stdlib CVEs in crypto/tls, crypto/x509, net/url, encoding/asn1, os/exec, database/sql).

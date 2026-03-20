---
'@opsen/platform': minor
'@opsen/k8s': minor
'@opsen/azure': minor
'@opsen/docker': minor
---

Add secret env vars and secret files support to the Workload type system

Introduces `SecretValue` and `SecretRef` types for env vars and file content, allowing runtimes to use their native secret mechanisms (K8s Secrets, ACA secrets, Azure Key Vault references). Plain string env vars and files continue to work unchanged.

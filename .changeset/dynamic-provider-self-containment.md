---
'@opsen/docker-compose': patch
---

fix(docker-compose): replace dynamic require() with static imports in MirrorState provider

The MirrorState dynamic provider used `resolveForDynamicProvider()` to compute
absolute paths at module load time, then `require(path)` inside provider methods.
These computed path strings were captured in Pulumi's closure serialization and
baked into state — if the build directory changed, deserialization would break.

Replaced with standard static imports. Pulumi's closure serializer automatically
inlines local module code by value, so static imports work correctly.

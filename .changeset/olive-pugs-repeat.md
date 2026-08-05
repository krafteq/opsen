---
'@opsen/agent': patch
---

fix(agent): ingress upstream deny list no longer skipped by an unparseable target

`policy.MatchUpstream` returned a bare `bool`, so "could not parse this target"
was indistinguishable from "this target does not match". At the deny-list call
site that read as "not denied", so a route whose `upstream` carried a scheme
(`h2c://10.0.0.5:8080`) or a trailing path (`10.0.0.5:8080/`) walked past
`deny_targets` — and because the drivers write `upstream` into the proxy config
verbatim, it was a working route rather than one that broke at reload.

An upstream that is not a bare `host:port` is now rejected with a policy
violation naming the route, under a deny-only policy and an allow-list policy
alike.

Separately, portless deny patterns (`10.0.0.5`, `10.0.0.0/8`) previously matched
nothing at all — the host-only fallback the code's own comment promised was
never implemented, so a plausible `deny_targets` entry was a silent no-op. A
pattern with no port half now matches the host on any port, and patterns that
could never match (malformed CIDR, non-numeric or inverted port range, missing
host) fail the client policy file at load instead of loading inert.

Scope: defense-in-depth on an mTLS-authenticated deploy client's own routes, not
the primary authorization boundary.

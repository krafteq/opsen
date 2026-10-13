---
'@opsen/agent': patch
---

Create the `opsen-agent` user on fresh non-root targets. The installer's setup script runs through `sudo sh -c` for non-root SSH users, and `/bin/sh` is dash on Ubuntu. Its user check used the bash-only `&>`, which dash parses as "run `id` in the background", so `useradd` never ran and the next `chown` failed with `invalid user: opsen-agent`. The check now uses POSIX redirection.

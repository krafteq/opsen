import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSetupCommands } from '../agent-installer'

// Non-root targets run the setup through `sudo sh -c`, and `/bin/sh` is dash on
// Ubuntu. Use dash when available so bash-only syntax fails here as it does there.
const SHELL = spawnSync('sh', ['-c', 'command -v dash']).status === 0 ? 'dash' : 'sh'

/** Runs the setup script against fake system commands that log their calls. */
function runSetup(opts: { userExists: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-setup-'))
  const log = path.join(root, 'calls')
  const users = path.join(root, 'users')
  if (opts.userExists) fs.writeFileSync(users, 'opsen-agent\n')
  const shim = (name: string, body: string) =>
    fs.writeFileSync(path.join(root, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 })
  shim('id', `grep -qx "$2" "${users}" 2>/dev/null || { echo "id: '$2': no such user" >&2; exit 1; }`)
  shim('useradd', `for last; do :; done; echo "$last" >> "${users}"`)
  shim('mkdir', 'exit 0')
  shim(
    'chown',
    `owner=\${2%%:*}; [ "$1" = -R ] || owner=\${1%%:*}; grep -qx "$owner" "${users}" 2>/dev/null || [ "$owner" = deploy ] || { echo "chown: invalid user: $owner" >&2; exit 1; }`,
  )
  const result = spawnSync(SHELL, ['-c', buildSetupCommands('deploy', '/etc/caddy').join('\n')], {
    env: { ...process.env, PATH: `${root}:${process.env['PATH'] ?? ''}` },
    encoding: 'utf8',
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  return { status: result.status, stderr: result.stderr, calls }
}

describe('agent setup script', () => {
  it('creates the opsen-agent user on a fresh non-root target', () => {
    const result = runSetup({ userExists: false })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.calls).toContain('useradd --system --no-create-home --shell /usr/sbin/nologin opsen-agent')
  })

  it('does not recreate an existing user', () => {
    const result = runSetup({ userExists: true })
    expect(result.status).toBe(0)
    expect(result.calls.some((c) => c.startsWith('useradd'))).toBe(false)
  })

  it('uses no bash-only redirection', () => {
    for (const line of buildSetupCommands('deploy', '/etc/caddy')) {
      expect(line).not.toMatch(/&>/)
    }
  })
})

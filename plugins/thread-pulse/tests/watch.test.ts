import { describe, expect, test } from 'claude-code/testing'

import { cleanTerminal, docIdOf, exitCodeOf, redact, tailOutput } from '../hooks/watch'

describe('command watch helpers', () => {
  test('masks secrets and keeps ordinary text', async () => {
    expect(redact('password: hunter2x')).toBe('password: ***')
    expect(redact('Authorization: Bearer abcdef123456')).toBe('Authorization: Bearer ***')
    expect(redact('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('token=***')
    expect(redact('  tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2Z0lCQUR')).toBe('  tls.key: [masked]')
    // A git SHA is lower-case hex, not a secret.
    expect(redact('commit 0f47a1b2c3d4e5f60718293a4b5c6d7e8f901234')).toBe('commit 0f47a1b2c3d4e5f60718293a4b5c6d7e8f901234')
    expect(redact('kubectl get pods -n kube-system')).toBe('kubectl get pods -n kube-system')
  })

  test('shows progress lines in their last state', async () => {
    expect(cleanTerminal('\u001b[32mok\u001b[0m\n 10%\r 50%\r100%\ndone')).toBe('ok\n100%\ndone')
  })

  test('keeps the tail of long output', async () => {
    const long = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    const { output, outputTruncated } = tailOutput(long)
    expect(outputTruncated).toBe(true)
    expect(output.endsWith('line 4999')).toBe(true)
    expect(output.startsWith('line ')).toBe(true)
  })

  test('reads exit codes and ids', async () => {
    expect(exitCodeOf('Exit code 2\nboom')).toBe(2)
    expect(exitCodeOf('fine')).toBe(null)
    expect(docIdOf('cc45d8a0-8c19', 'toolu_01/X')).toBe('cc45d8a0-toolu_01_X')
  })
})

import { describe, expect, test } from 'claude-code/testing'

import { composeStatus, describeCall, formatElapsed, longCalls, pulseLine } from '../hooks/pulse'

const CHECKLIST = 'Lab cleanup\n\n✓ Lab is up\n✱ Re-cloning vc1-datastore-2\n○ Find why k3d hung'

describe('pulse helpers', () => {
  test('names a shell call by its command', async () => {
    expect(describeCall('Bash', { command: 'k3d cluster start lab-infra', description: 'start' })).toBe(
      'Bash: k3d cluster start lab-infra',
    )
    expect(describeCall('mcp__remote-devices__device_bash', { command: 'helm ls' })).toBe(
      'remote-devices device_bash: helm ls',
    )
    expect(describeCall('Agent', { description: 'Review the diff', prompt: 'long' })).toBe(
      'subagent: Review the diff',
    )
  })

  test('formats elapsed time', async () => {
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(21 * 60_000 + 3_000)).toBe('21m03s')
  })

  test('puts the pulse line under the current step', async () => {
    const now = 1_000_000_000
    const calls = longCalls(
      [
        { tool: 'Bash', label: 'Bash: k3d cluster start lab-infra', startedAt: now - 21 * 60_000, isSubagent: false },
        { tool: 'Read', label: 'Read: a.md', startedAt: now - 2_000, isSubagent: false },
      ],
      now,
      60_000,
    )
    expect(calls.length).toBe(1)
    const text = composeStatus(CHECKLIST, calls.map(c => pulseLine(c, now, 10 * 60_000)))
    expect(text).toBe(
      'Lab cleanup\n\n✓ Lab is up\n✱ Re-cloning vc1-datastore-2\n' +
        '✱ ⚠ No result after 21 min, may be stuck: Bash: k3d cluster start lab-infra\n' +
        '○ Find why k3d hung',
    )
  })

  test('works without a checklist from the model', async () => {
    expect(composeStatus(undefined, ['✱ Still running (2 min): Bash: sleep 300'])).toBe(
      'Thread activity\n\n✱ Still running (2 min): Bash: sleep 300',
    )
    expect(composeStatus(CHECKLIST, [])).toBe(CHECKLIST)
  })
})

// Pure helpers: what a running call is called, how long it ran, and the
// checklist text with the "still running" lines folded in.

export type Running = {
  tool: string
  label: string
  startedAt: number
  isSubagent: boolean
}

export const DEFAULT_HEADER = 'Thread activity'

const MAX_LABEL = 70

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim().replace(/`/g, "'")
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line
}

const firstString = (args: Record<string, unknown>): string | undefined => {
  for (const key of ['description', 'command', 'url', 'file_path', 'pattern', 'prompt', 'query']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

// "Bash: k3d cluster start lab-infra", "subagent: Review the diff",
// "remote-devices device_bash: helm upgrade ...".
export const describeCall = (tool: string, args: Record<string, unknown>): string => {
  if (tool === 'Agent' || tool === 'Task') {
    const what = firstString(args)
    return what === undefined ? 'subagent' : `subagent: ${clip(what)}`
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const name = mcp === null ? tool : `${mcp[1]} ${mcp[2]}`
  // For a shell call the command says more than the model's description.
  const what =
    typeof args.command === 'string' && args.command.trim() !== ''
      ? args.command
      : firstString(args)
  return what === undefined ? name : `${name}: ${clip(what)}`
}

export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// Minutes only, so the thread checklist changes at most once a minute.
export const formatMinutes = (ms: number): string => {
  const m = Math.max(1, Math.floor(ms / 60000))
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

// The calls past the threshold, oldest first, at most `limit`.
export const longCalls = (
  running: Iterable<Running>,
  now: number,
  thresholdMs: number,
  limit = 3,
): Running[] =>
  [...running]
    .filter(call => now - call.startedAt >= thresholdMs)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, limit)

export const pulseLine = (call: Running, now: number, warnMs: number): string => {
  const age = now - call.startedAt
  const who = call.isSubagent ? 'subagent ' : ''
  return age >= warnMs
    ? `✱ ⚠ No result after ${formatMinutes(age)}, may be stuck: ${who}${call.label}`
    : `✱ Still running (${formatMinutes(age)}): ${who}${call.label}`
}

// The model's checklist with the pulse lines placed right after its current
// step (the last ✱ line), or at the end when it has none.
export const composeStatus = (base: string | undefined, lines: string[]): string => {
  const rows = (base ?? DEFAULT_HEADER).split('\n')
  if (lines.length === 0) return rows.join('\n')
  let at = -1
  rows.forEach((row, i) => {
    if (row.replace(/^\*\*/, '').trimStart().startsWith('✱')) at = i
  })
  if (at === -1) {
    const tail = rows.length === 1 ? ['', ...lines] : lines
    return [...rows, ...tail].join('\n')
  }
  return [...rows.slice(0, at + 1), ...lines, ...rows.slice(at + 1)].join('\n')
}

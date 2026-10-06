// Pure helpers for the Command Watch page: what a card holds, masking
// secrets, cutting long output.

export const OUTPUT_KEEP = 16_000

// One Bash call as the page reads it (one JSON file per call).
export type CallDoc = {
  session: string
  sessionLabel: string
  tool: string
  command: string
  description: string
  timeoutMs: number
  background: boolean
  startedAt: number
  updatedAt: number
  lastOutputAt: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed' | 'interrupted'
  exitCode: number | null
  output: string
  outputTruncated: boolean
}

const hasMixedBase64 = (s: string): boolean => /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)

// Best effort: keys, tokens and `password: x` style values become ***.
export const redact = (text: string): string =>
  text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key masked]')
    .replace(/AGE-SECRET-KEY-1[0-9A-Z]+/g, 'AGE-SECRET-KEY-***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})\b/g, '***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
    .replace(
      /((?:password|passwd|pass|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',}]{3,})/gi,
      '$1***',
    )
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, m => (hasMixedBase64(m) ? '[masked]' : m))

// Terminal output as a person would see it: no colour codes, and a line
// redrawn with \r (a progress bar) shows its last state.
export const cleanTerminal = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '')
    .split('\n')
    .map(line => {
      const parts = line.split('\r')
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i]
      return ''
    })
    .join('\n')

export const tailOutput = (text: string): { output: string; outputTruncated: boolean } => {
  const clean = redact(cleanTerminal(text))
  if (clean.length <= OUTPUT_KEEP) return { output: clean, outputTruncated: false }
  const cut = clean.slice(-OUTPUT_KEEP)
  const nl = cut.indexOf('\n')
  return { output: nl >= 0 && nl < 400 ? cut.slice(nl + 1) : cut, outputTruncated: true }
}

// "Exit code 2" at the head of a failed Bash result.
export const exitCodeOf = (text: string | undefined): number | null => {
  const m = /Exit code (\d+)/.exec(text ?? '')
  return m === null ? null : Number(m[1])
}

export const docIdOf = (session: string, toolUseId: string): string =>
  `${session.slice(0, 8)}-${toolUseId}`.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 200)

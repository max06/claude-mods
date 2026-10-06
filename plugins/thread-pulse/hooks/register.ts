import type { EngineInterface, Register } from 'claude-code'

import {
  composeStatus,
  DEFAULT_HEADER,
  describeCall,
  formatElapsed,
  longCalls,
  pulseLine,
  type Running,
} from './pulse'
import { type CallDoc, docIdOf, exitCodeOf, tailOutput } from './watch'

// In a Claude project thread the checklist the person sees is written by
// the hearthbot server's update_status tool. Elsewhere it is absent and the
// mod keeps to the status line.
const HEARTH_SERVER = 'hearthbot'
const HEARTH_STATUS = 'mcp__hearthbot__update_status'
const TICK_MS = 15_000
// Command Watch: how often running output is read and sent, and how often a
// quiet call still says the device is alive.
const WATCH_TICK_MS = 2_000
const HEARTBEAT_MS = 15_000
const MAX_READ = 4 * 1024 * 1024

// Module state; a reload starts it over, which only drops the calls in flight.
const running = new Map<string, Running>()
let thresholdMs = 60_000
let warnMs = 600_000
// The last checklist the model wrote, without our lines.
let base: string | undefined
// What was last written to the thread, so a tick only writes on change.
let pushed: string | undefined
let statusLine: string | undefined
let hasHearth: boolean | undefined
let hearthCheckedAt = 0

// One Bash call fed to the Command Watch page.
type Watch = {
  docId: string
  // The command's letters and digits, as found in its shell's command line.
  key: string
  doc: CallDoc
  file?: string
  size: number
  lastWriteAt: number
  taskId?: string
  isEnded: boolean
  chain: Promise<void>
}
// Command Watch: one JSON file per call, read by command-watch-server.py.
let isLocalWatch = true
let localDir = ''
let sessionId = ''
let sessionLabel = ''
// undefined: not looked for yet; null: looked for and not found.
let tasksDir: string | null | undefined
const claimed = new Set<string>()
const watches = new Map<string, Watch>()
// The page server: every session tries to start it, the first to bind the
// port serves, and the others try again in a minute in case it went away.
const SERVE_RETRY_MS = 60_000
let isServeWatch = true
let watchPort = 8765
// 'off': not started; 'serving': this session's child holds the port;
// 'elsewhere': another process holds it; 'no-python': python3 did not start.
let serveState: 'off' | 'serving' | 'elsewhere' | 'no-python' = 'off'

const alnum = (text: string): string => text.replace(/[^A-Za-z0-9]/g, '')

const isWatching = (): boolean => localDir !== ''

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

async function findHearth($: EngineInterface, now: number): Promise<boolean> {
  if (hasHearth === true) return true
  if (hasHearth === false && now - hearthCheckedAt < 60_000) return false
  hearthCheckedAt = now
  const tools = await $.tool.list()
  hasHearth = tools.some(t => t.name === HEARTH_STATUS)
  return hasHearth
}

async function pushStatus($: EngineInterface, text: string): Promise<void> {
  if (text === pushed) return
  const res = await $.mcp.call(HEARTH_SERVER, 'update_status', { text })
  if (!res.isError) pushed = text
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const long = longCalls(running.values(), now, thresholdMs)

  const line =
    long.length === 0
      ? undefined
      : `⏳ ${long.map(c => `${formatElapsed(now - c.startedAt)} ${c.label}`).join(' · ')}`
  if (line !== statusLine) {
    statusLine = line
    $.ui.status(line)
  }

  if (!(await findHearth($, now))) return
  if (long.length > 0) {
    await pushStatus($, composeStatus(base, long.map(c => pulseLine(c, now, warnMs))))
  } else if (pushed !== undefined && pushed !== (base ?? DEFAULT_HEADER)) {
    // The long calls ended: put the model's own checklist back.
    await pushStatus($, base ?? DEFAULT_HEADER)
  }
}

// The engine writes each shell command's output to
// <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output as it runs.
async function findTasksDir($: EngineInterface): Promise<string | null> {
  if (tasksDir !== undefined) return tasksDir
  tasksDir = null
  const tmp = (await $.env.get('CLAUDE_CODE_TMPDIR')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  const roots = (await $.fs.list(tmp).catch(() => [])).filter(
    d => d.kind === 'dir' && d.name.startsWith('claude-'),
  )
  // The project folder is named after the session's directory.
  const slug = (await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')
  for (const root of roots) {
    const dir = `${tmp}/${root.name}/${slug}/${sessionId}/tasks`
    if (await $.fs.exists(dir)) {
      tasksDir = dir
      return dir
    }
  }
  for (const root of roots) {
    for (const project of await $.fs.list(`${tmp}/${root.name}`).catch(() => [])) {
      const dir = `${tmp}/${root.name}/${project.name}/${sessionId}/tasks`
      if (project.kind === 'dir' && (await $.fs.exists(dir))) {
        tasksDir = dir
        return dir
      }
    }
  }
  return null
}

// Writes go one at a time per card, so a later state never lands first.
function writeDoc($: EngineInterface, w: Watch, patch: Partial<CallDoc>): void {
  Object.assign(w.doc, patch)
  w.chain = w.chain
    .then(async () => {
      const now = await $.clock.now()
      w.lastWriteAt = now
      await $.fs.write(`${localDir}/${w.docId}.json`, JSON.stringify({ id: w.docId, ...w.doc, updatedAt: now }))
    })
    .catch(() => undefined)
}

async function readOutput($: EngineInterface, w: Watch): Promise<boolean> {
  if (w.file === undefined) return false
  const stat = await $.fs.stat(w.file).catch(() => undefined)
  if (stat === undefined || stat.size === w.size) return false
  w.size = stat.size
  if (stat.size > MAX_READ) {
    writeDoc($, w, { output: `(output is ${Math.round(stat.size / 1048576)} MiB, too large to show live)`, outputTruncated: true })
    return true
  }
  const text = await $.fs.read(w.file)
  writeDoc($, w, { ...tailOutput(text), lastOutputAt: await $.clock.now() })
  return true
}

// Each running shell has its output file open as stdout; its command line
// holds the command, so the two are matched through /proc (Linux).
const SCAN = 'for p in /proc/[0-9]*; do f=$(readlink "$p/fd/1" 2>/dev/null) || continue; ' +
  'case "$f" in */tasks/*.output) printf "%s\\t" "$f"; tr "\\0\\n" "  " < "$p/cmdline"; echo;; esac; done'

async function claimFiles($: EngineInterface): Promise<void> {
  const waiting = [...watches.values()].filter(w => w.file === undefined && !w.isEnded)
  if (waiting.length === 0) return
  // Only this session's own output files: another session's shell may
  // mention the same command (claude -p "run X").
  const dir = await findTasksDir($)
  if (dir === null) return
  const scan = await $.process.run(['sh', '-c', SCAN]).catch(() => undefined)
  if (scan === undefined) return
  const shells = scan.stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter((parts): parts is [string, string] => parts.length === 2 && (parts[0] ?? '').startsWith(`${dir}/`))
  for (const w of waiting) {
    const hit = shells.find(([file, cmdline]) => !claimed.has(file) && alnum(cmdline).includes(w.key))
    if (hit === undefined) continue
    claimed.add(hit[0])
    w.file = hit[0]
  }
}

async function watchTick($: EngineInterface): Promise<void> {
  if (!isWatching() || watches.size === 0) return
  await claimFiles($)
  const now = await $.clock.now()
  for (const w of watches.values()) {
    if (w.isEnded) continue
    const changed = await readOutput($, w)
    if (!changed && now - w.lastWriteAt > HEARTBEAT_MS) writeDoc($, w, {})
  }
}

async function endWatch($: EngineInterface, key: string, w: Watch, patch: Partial<CallDoc>): Promise<void> {
  w.isEnded = true
  w.size = -1
  await readOutput($, w)
  writeDoc($, w, { ...patch, endedAt: await $.clock.now() })
  watches.delete(key)
}

async function serveWatch($: EngineInterface): Promise<void> {
  const script = `${$.plugin.root}/command-watch/command-watch-server.py`
  for (;;) {
    try {
      const child = $.process.spawn({ argv: ['python3', script, '--port', String(watchPort)] })
      // The server prints its address once it holds the port, then nothing.
      for await (const { stream, text } of child) {
        if (stream === 'stdout' && text.includes('Command Watch on')) serveState = 'serving'
      }
    } catch {
      serveState = 'no-python'
      return
    }
    // The port was taken, or our server stopped: someone else may serve now.
    serveState = 'elsewhere'
    await $.clock.sleep(SERVE_RETRY_MS)
  }
}

export const register: Register = (on, options) => {
  thresholdMs = num(options.thresholdSeconds, 60) * 1000
  warnMs = num(options.warnMinutes, 10) * 60_000
  isLocalWatch = options.localWatch !== false
  isServeWatch = options.serveWatch !== false
  watchPort = num(options.watchPort, 8765)

  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const home = await $.env.get('HOME')
    localDir = isLocalWatch && home !== undefined ? `${home}/.claude/command-watch/calls` : ''
    const host = await $.process.run(['hostname']).then(r => r.stdout.trim()).catch(() => '')
    const dir = e.cwd.split('/').filter(Boolean).at(-1) ?? e.cwd
    sessionLabel = `${host === '' ? '' : `${host} · `}${dir} · ${sessionId.slice(0, 8)}`
    $.clock.every(TICK_MS, () => {
      tick($).catch(() => undefined)
    })
    $.clock.every(WATCH_TICK_MS, () => {
      watchTick($).catch(() => undefined)
    })
    if (isWatching() && isServeWatch) void serveWatch($)
    // A second copy of the mod may hold the names; the mod runs without them.
    await $.command
      .register({
        name: 'pulse',
        description: 'List the tool calls running now and how long each has run',
      })
      .catch(() => undefined)
    await $.command
      .register({
        name: 'command-watch',
        description: 'Show where the Command Watch page is served',
      })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    const now = await $.clock.now()
    const all = longCalls(running.values(), now, 0, 50)
    if (all.length === 0) return { text: 'No tool call is running.' }
    return {
      text: all
        .map(c => `${formatElapsed(now - c.startedAt)}  ${c.isSubagent ? 'subagent ' : ''}${c.label}`)
        .join('\n'),
    }
  })

  on('command.run', { command: 'command-watch' }, async $ => {
    if (!isWatching()) return { text: 'Command Watch is off (option localWatch).' }
    const url = `http://127.0.0.1:${watchPort}/`
    const start = `python3 ${$.plugin.root}/command-watch/command-watch-server.py --port ${watchPort}`
    switch (serveState) {
      case 'serving':
        return { text: `Command Watch: ${url} (served by this session)` }
      case 'elsewhere':
        return { text: `Command Watch: ${url} (served by another session or process)` }
      case 'no-python':
        return { text: `Command Watch could not start: python3 was not found. Start it yourself:\n${start}` }
      default:
        return { text: `Command Watch is not served by the mod (option serveWatch). Start it yourself:\n${start}\nthen open ${url}` }
    }
  })

  // The model's own checklist writes: keep the latest as the base.
  on('tool.call', { tool: HEARTH_STATUS }, async ($, e, next) => {
    const text = (e as { text?: unknown }).text
    if (typeof text === 'string') base = text
    const ran = await next(e)
    if (typeof text === 'string' && ran.deny === undefined && ran.isError !== true) pushed = text
    return ran
  })

  // Every shell command becomes a card on the Command Watch page.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isWatching()) return next(e)
    const now = await $.clock.now()
    const w: Watch = {
      docId: docIdOf(sessionId, e.tool_use_id),
      key: alnum(e.command).slice(0, 80),
      size: -1,
      lastWriteAt: now,
      isEnded: false,
      chain: Promise.resolve(),
      doc: {
        session: sessionId,
        sessionLabel,
        tool: 'Bash',
        command: tailOutput(e.command).output,
        description: e.description ?? '',
        timeoutMs: e.timeout ?? (e.run_in_background === true ? 1_800_000 : 120_000),
        background: e.run_in_background === true,
        startedAt: now,
        updatedAt: now,
        lastOutputAt: now,
        endedAt: null,
        status: 'running',
        exitCode: null,
        output: '',
        outputTruncated: false,
      },
    }
    watches.set(e.tool_use_id, w)
    writeDoc($, w, {})

    const ran = await next(e).catch((err: unknown) => {
      void endWatch($, e.tool_use_id, w, { status: 'interrupted' })
      throw err
    })
    if (ran.deny !== undefined) {
      await endWatch($, e.tool_use_id, w, { status: 'failed', output: ran.deny })
      await w.chain
      return ran
    }
    const r = ran.result as Partial<{ stdout: string; stderr: string; interrupted: boolean; backgroundTaskId: string }>
    const taskId = ran.isError === true ? undefined : r?.backgroundTaskId
    if (taskId !== undefined) {
      // Moved to the background (asked for, Ctrl+B or a timeout): the task's
      // own file keeps growing until its notification arrives.
      const dir = await findTasksDir($)
      w.taskId = taskId
      if (dir !== null) w.file = `${dir}/${taskId}.output`
      if (w.file !== undefined) claimed.add(w.file)
      writeDoc($, w, { background: true })
      await w.chain
      return ran
    }
    if (w.file === undefined) {
      writeDoc($, w, tailOutput([r?.stdout, r?.stderr].filter(Boolean).join('\n') || (ran.text ?? '')))
    }
    await endWatch($, e.tool_use_id, w, {
      status: r?.interrupted === true ? 'interrupted' : ran.isError === true ? 'failed' : 'done',
      exitCode: ran.isError === true ? exitCodeOf(ran.text) : r?.interrupted === true ? null : 0,
    })
    await w.chain
    return ran
  })

  // A background command ends with a task notification naming its id.
  on('session.append', async ($, e, next) => {
    if (isWatching()) {
      const text = JSON.stringify(e.message.content ?? '')
      for (const [key, w] of watches) {
        if (w.taskId === undefined || !text.includes(`<task-id>${w.taskId}</task-id>`)) continue
        const status = /<status>(\w+)<\/status>/.exec(text)?.[1] ?? ''
        if (status === '' || status === 'running') continue
        const code = /exit code (\d+)/i.exec(text)
        await endWatch($, key, w, {
          status: status === 'completed' ? 'done' : status === 'killed' ? 'interrupted' : 'failed',
          exitCode: code === null ? null : Number(code[1]),
        })
        await w.chain
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__hearthbot__')) return next(e)
    const { tool, tool_use_id, agentId, ...args } = e as {
      tool: string
      tool_use_id: string
      agentId?: string
    } & Record<string, unknown>
    running.set(tool_use_id, {
      tool,
      label: describeCall(tool, args),
      startedAt: await $.clock.now(),
      isSubagent: agentId !== undefined,
    })
    try {
      return await next(e)
    } finally {
      running.delete(tool_use_id)
      // Clear the line now rather than at the next tick.
      if (statusLine !== undefined || (pushed !== undefined && pushed !== (base ?? DEFAULT_HEADER))) {
        await tick($).catch(() => undefined)
      }
    }
  })
}

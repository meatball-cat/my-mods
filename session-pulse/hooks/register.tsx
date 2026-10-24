// Session Pulse: every open Claude Code session on one live board.
// - Each session writes a heartbeat, ~/.claude/mods-data/session-pulse/s-<id>.json:
//   its state (working, waiting on you, done, stopped, error, idle), when its turn
//   started, how long that turn should take, its task plan when it keeps one
//   (TodoWrite, the Task tools, savvy-progress, goal-meter) and what it is doing.
// - The band above the prompt draws a row per live session: a colored dot, the
//   title, a bar, the percent and a rough time left. Click a row to switch to that
//   session (the desktop app opens it; for a terminal session its resume command
//   is copied). x hides a row until that session starts its next turn.
// - /pulse opens the whole board in a pane: idle, hidden and silent sessions too,
//   with what each one is doing. /pulse compact|full|off, /pulse alerts on|off,
//   /pulse show (bring hidden rows back), /pulse name <title>.
// - The percent comes from the plan when there is one, else from how long turns
//   usually take, learned per session and across sessions. The bar warms from
//   orange to yellow-green as it fills; blue means the session needs you.
// - It sends no model requests and adds nothing to Claude's prompt.

import { atom, read, update } from 'claude-code'
import type { CommandRunResult, Elements, EngineInterface, Register, RenderElement, RenderSurface, ToolCallResult } from 'claude-code'

import type { Beat, Plan, Prefs, PulseState, Row } from '../types'
import {
  COLOR,
  DEFAULT_TURN_MS,
  asDigitFont,
  HOST_ID,
  HOUR,
  MIN,
  SEC,
  SVG_HEIGHT,
  activityOf,
  askNeed,
  agoText,
  asBeat,
  barCells,
  barSvg,
  basename,
  cells,
  clamp,
  clip,
  colorOf,
  demoTiming,
  durText,
  estimate,
  etaText,
  expectedMs,
  fit,
  goalPlan,
  iconOf,
  permissionNeed,
  savvyPlan,
  tasksPlan,
  titleFromPrompt,
  todosPlan,
  withChange,
  workingColor,
} from './estimate'
import type { DigitFont, TaskEntry } from './estimate'

const rowsAtom = atom({ plugin: 'session-pulse', key: 'rows' } as const, [])
const nowAtom = atom({ plugin: 'session-pulse', key: 'now' } as const, 0)
const prefsAtom = atom({ plugin: 'session-pulse', key: 'prefs' } as const, { mode: 'full', alerts: true })
const maskedAtom = atom({ plugin: 'session-pulse', key: 'isMasked' } as const, false)

const PANE = 'session-pulse'
const DATA = '/.claude/mods-data/session-pulse'
const DESKTOP_SESSIONS = '/Library/Application Support/Claude/claude-code-sessions'
const SAVVY_PROGRESS = 'mcp__savvy-progress__progress'
const SAVVY_STEP = 'mcp__savvy-progress__step'
const GOAL_TOOL = 'mcp__goal-meter__tasks'
const BEAT_MS = 15 * SEC // a live session rewrites its file at least this often
const STALE_MS = 75 * SEC // a file older than this belongs to a session that stopped answering
const FORGET_MS = 12 * HOUR // files older than this are removed
const RECENT_MS = 60 * MIN // a finished session stays on the band this long
const MISSED_TURN_GRACE_MS = 15 * SEC // the band may draw before the engine marks a new turn running
const HEARD_TURN_GRACE_MS = 3 * MIN // a turn this module heard start must look idle this long before it is settled
const BAND_ROWS = 6
// The status dot's column: a row's title and its detail line both start after it.
const ICON_CELLS = 2
const BEAT_FILE = /^s-([A-Za-z0-9-]{8,64})\.json$/
const HIDE_FILE = /^hide-([A-Za-z0-9-]{8,64})\.json$/

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type SvgElement = Elements['desktop']['Svg']
type Item = { row: Row; label: string }
type View = { pct: number; pctText: string; color: string; tail: string; tailColor: string; tailHex: string; isLive: boolean; state: string; stateColor: string }
type CachedFile = { mtimeMs: number; beat: Beat | null; hiddenAt: number }

// This session
let home = ''
let dir = ''
let hostId = ''
let me: Beat | null = null
let isTracked = false
let isTicking = false
let isBusy = false
let isDirty = false
let lastWrite = 0
let titleFrom: 'name' | 'desktop' | 'prompt' | 'folder' = 'folder'
let desktopRecord = ''
let myTurns: number[] = []
let pace: number[] = []
let waitKind: '' | 'ask' | 'permission' = ''
// The turn this module itself heard start (a reload loses it), when the engine's
// band first said no turn was running, and whether a row was settled by that.
let heardStartAt = 0
let notWorkingSince = 0
let isSettledEarly = false
let commandName = 'pulse'
const tasks = new Map<string, TaskEntry>()
// The app's own digit outlines (scripts/digits-from-app-font.py), when extracted.
let digitFont: DigitFont | null = null

// What this session sees of the others
const files = new Map<string, CachedFile>()
const hidden = new Map<string, number>()
const lastState = new Map<string, PulseState>()
const highest = new Map<string, number>()
// What each drawing site last showed per session, so the next drawing animates
// from there: the bar grows, the changed digits roll.
const lastShown = new Map<string, { pct: number; pctText: string }>()
let hasScanned = false
let ticks = 0
let lastPrune = 0

// /pulse demo: made-up sessions for a few minutes, never written to disk
const DEMO_PREFIX = 'demo0000-'
let demo: Beat[] = []
let demoUntil = 0
const demoHidden = new Set<string>()
const isDemo = (id: string): boolean => id.startsWith(DEMO_PREFIX)

const beatPath = (id: string): string => `${dir}/s-${id}.json`
const hidePath = (id: string): string => `${dir}/hide-${id}.json`

function freshBeat(id: string, surface: string, cwd: string, at: number): Beat {
  return {
    v: 1,
    id,
    hostId,
    surface,
    title: '',
    project: basename(cwd),
    cwd,
    state: 'idle',
    bornAt: at,
    startedAt: 0,
    endedAt: 0,
    waitMs: 0,
    waitingSince: 0,
    tools: 0,
    activity: '',
    plan: null,
    planAt: 0,
    expectMs: DEFAULT_TURN_MS,
    turns: 0,
    lastMs: 0,
    stopPct: 0,
    agents: 0,
    updatedAt: at,
  }
}

function demoBeats(at: number): Beat[] {
  const make = (i: number, title: string, project: string, over: Partial<Beat>): Beat => ({
    ...freshBeat(`${DEMO_PREFIX}0000-0000-0000-00000000000${i}`, 'desktop', `/demo/${project}`, at - (10 - i) * MIN),
    hostId: '',
    title,
    turns: 1,
    ...over,
  })
  const working = (pct: number, etaMinutes: number, activity: string): Partial<Beat> => {
    const timing = demoTiming(pct, etaMinutes * MIN)
    return { state: 'working', startedAt: at - timing.workedMs, expectMs: timing.expectMs, activity }
  }
  return [
    make(1, 'Edit the opening animation', 'promo-video', working(72, 30, 'Rendering frames')),
    make(2, 'Fix the login bug', 'webapp', { state: 'done', startedAt: at - 9 * MIN, endedAt: at - 3 * MIN, lastMs: 6 * MIN, turns: 3 }),
    make(3, 'Write the newsletter', 'newsletter', working(45, 12, 'Editing issue-42.md')),
    make(4, 'Organize research notes', 'research', working(88, 5, 'Reading sources.md')),
    make(5, 'Review the payments PR', 'payments', { state: 'waiting', startedAt: at - 4 * MIN, waitingSince: at - MIN, expectMs: 6 * MIN, activity: 'Waiting for your permission', need: 'allow bash', turns: 2 }),
  ]
}

async function loadDigitFont($: EngineInterface): Promise<DigitFont | null> {
  try {
    const path = `${dir}/digits.json`
    if (!(await $.fs.exists(path))) return null
    return asDigitFont(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

async function saveDemo($: EngineInterface, startedAt: number): Promise<void> {
  try {
    await $.store.set('demo', startedAt)
  } catch {
    // the demo ends with this load
  }
}

// A demo started before a hot reload carries on where it was.
async function restoreDemo($: EngineInterface, at: number): Promise<void> {
  try {
    const startedAt = await $.store.get('demo')
    if (typeof startedAt === 'number' && startedAt > 0 && at < startedAt + 3 * MIN) {
      demo = demoBeats(startedAt)
      demoUntil = startedAt + 3 * MIN
    }
  } catch {
    // no demo to restore
  }
}

function beatOf(row: Row): Beat {
  const { isSelf, isHidden, isStale, ...beat } = row
  return beat
}

const isHiddenBeat = (b: Beat, hiddenAt: number): boolean => hiddenAt > 0 && b.startedAt <= hiddenAt

const byBirth = (a: Row, b: Row): number => a.bornAt - b.bornAt || (a.id < b.id ? -1 : 1)

function selfRow(): Row | null {
  return me === null ? null : { ...me, isSelf: true, isHidden: isHiddenBeat(me, hidden.get(me.id) ?? 0), isStale: false }
}

function labelOf(row: Row, index: number, isMasked: boolean): string {
  if (isMasked) return `session ${index + 1}`
  // The session's name exactly as Claude Code shows it.
  if (row.title) return row.title
  return row.project ? `untitled · ${row.project}` : 'untitled session'
}

function isOnBand(r: Row, at: number): boolean {
  if (r.isHidden || r.isStale || r.ended === true || r.state === 'idle') return false
  if (r.state === 'done' || r.state === 'stopped' || r.state === 'error') return at - r.endedAt < RECENT_MS
  return true
}

const isLiveState = (s: PulseState): boolean => s === 'working' || s === 'waiting'

// ---------------------------------------------------------------------------
// This session's own heartbeat

async function startTracking($: EngineInterface, cwd: string, surface: string): Promise<void> {
  if (isTracked || !dir) return
  isTracked = true
  const at = await $.clock.now()
  const id = await $.session.id()
  // A hot reload keeps $.state, so the row drawn before it carries on as it was.
  const kept = (await read($, rowsAtom)).find(r => r.isSelf && r.id === id)
  if (kept !== undefined) {
    me = beatOf(kept)
  } else {
    // A resumed session: keep its title, count and age; its last turn is over.
    const saved = await readBeat($, beatPath(id))
    me = freshBeat(id, surface, cwd, at)
    if (saved !== null && saved.ended !== true) {
      me = { ...me, title: saved.title, turns: saved.turns, lastMs: saved.lastMs, bornAt: saved.bornAt || at, endedAt: saved.endedAt, state: saved.turns > 0 ? 'done' : 'idle' }
    }
  }
  me = { ...me, hostId, surface: surface || me.surface, cwd, project: basename(cwd) }
  if (me.title) titleFrom = 'prompt'
  if (me.lastMs > 0) myTurns = [me.lastMs]
  pace = await loadPace($)
  digitFont = await loadDigitFont($)
  await restoreDemo($, at)
  await refreshTitle($)
  await writeSelf($)
  await scan($, at)
  startTicking($)
}

function startTicking($: EngineInterface): void {
  if (isTicking) return
  isTicking = true
  $.clock.every(SEC, () => {
    void tick($)
  })
}

async function tick($: EngineInterface): Promise<void> {
  if (me === null || isBusy) return
  isBusy = true
  try {
    ticks += 1
    const at = await $.clock.now()
    if (ticks % 5 === 0 || me.ended === true) await followClear($)
    if (isDirty || at - lastWrite >= BEAT_MS) await writeSelf($)
    if (ticks % 2 === 0) await scan($, at)
    if (ticks % 10 === 1) await readSettings($)
    // A rename in the app shows within seconds.
    if (ticks % 5 === 0 && titleFrom !== 'prompt') await refreshTitle($)
    else if (ticks % 120 === 0) await refreshTitle($)
    const list = await read($, rowsAtom)
    const isLive = list.some(r => isLiveState(r.state) && !r.isStale)
    if (isLive || ticks % 30 === 0) await update($, nowAtom, () => at)
  } catch {
    // the next tick tries again
  } finally {
    isBusy = false
  }
}

async function writeSelf($: EngineInterface): Promise<void> {
  if (me === null || !dir) return
  const at = await $.clock.now()
  me.updatedAt = at
  lastWrite = at
  isDirty = false
  try {
    await $.fs.write(beatPath(me.id), JSON.stringify(me))
  } catch {
    // this session still shows itself
  }
  const self = selfRow()
  if (self !== null) await update($, rowsAtom, list => [...list.filter(r => !r.isSelf), self].sort(byBirth))
}

async function writeEnded($: EngineInterface, beat: Beat): Promise<void> {
  try {
    await $.fs.write(beatPath(beat.id), JSON.stringify({ ...beat, ended: true, updatedAt: await $.clock.now() }))
  } catch {
    // its file goes stale and drops off the board
  }
}

async function readBeat($: EngineInterface, path: string): Promise<Beat | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return asBeat(JSON.parse(await $.fs.read(path)))
  } catch {
    return null
  }
}

// /clear gives the session a new id: the old row ends and a fresh one starts.
async function followClear($: EngineInterface): Promise<void> {
  if (me === null) return
  const id = await $.session.id()
  if (id === me.id) return
  await writeEnded($, me)
  const at = await $.clock.now()
  const keepTitle = titleFrom === 'desktop' || titleFrom === 'name' ? me.title : ''
  me = { ...freshBeat(id, me.surface, me.cwd, at), title: keepTitle }
  if (!keepTitle) titleFrom = 'folder'
  tasks.clear()
  myTurns = []
  waitKind = ''
  await refreshTitle($)
  await writeSelf($)
}

// The desktop app's own title for this session (what its sidebar shows), else
// the first prompt; the folder name until there is one.
async function refreshTitle($: EngineInterface): Promise<void> {
  if (me === null || titleFrom === 'name') return
  if (hostId) {
    if (!desktopRecord) desktopRecord = await findDesktopRecord($)
    if (desktopRecord) {
      try {
        const raw = JSON.parse(await $.fs.read(desktopRecord)) as { title?: unknown }
        const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : ''
        if (title) {
          if (title !== me.title) {
            me.title = title
            isDirty = true
          }
          titleFrom = 'desktop'
          return
        }
      } catch {
        desktopRecord = ''
      }
    }
  }
  if (me.title) return
  try {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return
    for (const m of messages) {
      const title = m.role === 'user' ? titleFromPrompt(m.text) : ''
      if (title) {
        me.title = title
        titleFrom = 'prompt'
        isDirty = true
        return
      }
    }
  } catch {
    // the folder name stands in
  }
}

async function findDesktopRecord($: EngineInterface): Promise<string> {
  const base = home + DESKTOP_SESSIONS
  try {
    if (!(await $.fs.exists(base))) return ''
    for (const account of await $.fs.list(base)) {
      if (account.kind !== 'dir') continue
      for (const org of await $.fs.list(`${base}/${account.name}`)) {
        if (org.kind !== 'dir') continue
        const path = `${base}/${account.name}/${org.name}/${hostId}.json`
        if (await $.fs.exists(path)) return path
      }
    }
  } catch {
    // no desktop record: the prompt names the session
  }
  return ''
}

async function loadPace($: EngineInterface): Promise<number[]> {
  try {
    const value = await $.store.get('pace')
    return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number' && n > 0).slice(-60) : []
  } catch {
    return []
  }
}

async function recordPace($: EngineInterface, ms: number): Promise<void> {
  pace = [...(await loadPace($)), Math.round(ms)].slice(-60)
  try {
    await $.store.set('pace', pace)
  } catch {
    // learned again from the next turns
  }
}

// Settings live in the store, so a change in one session reaches the others,
// and the recording flag Recording Mode keeps masks titles while it is on.
async function readSettings($: EngineInterface): Promise<void> {
  try {
    const saved = (await $.store.get('prefs')) as Partial<Prefs> | undefined
    const prefs: Prefs = {
      mode: saved?.mode === 'compact' || saved?.mode === 'off' ? saved.mode : 'full',
      alerts: saved?.alerts !== false,
    }
    const current = await read($, prefsAtom)
    if (current.mode !== prefs.mode || current.alerts !== prefs.alerts) await update($, prefsAtom, () => prefs)
  } catch {
    // defaults stand
  }
  let isRecording = false
  try {
    const path = `${home}/.claude/mods-data/recording.json`
    if (await $.fs.exists(path)) isRecording = (JSON.parse(await $.fs.read(path)) as { on?: unknown }).on === true
  } catch {
    isRecording = false
  }
  if (isRecording !== (await read($, maskedAtom))) await update($, maskedAtom, () => isRecording)
}

async function savePrefs($: EngineInterface, change: (p: Prefs) => Prefs): Promise<Prefs> {
  const prefs = await update($, prefsAtom, change)
  try {
    await $.store.set('prefs', prefs)
  } catch {
    // this session keeps it until it ends
  }
  return prefs
}

// ---------------------------------------------------------------------------
// The turn: started, its tool calls, waits on the person, its end

function setPlan(counts: { done: number; active: number; total: number } | null, source: string, at: number, activity: string): void {
  if (me === null) return
  const prev = me.plan
  const plan = counts === null ? null : withChange(prev, counts, source, at)
  // A new list, or one that started over, restarts the plan's clock.
  if (plan !== null && (prev === null || prev.source !== source || plan.done < prev.done)) me.planAt = at
  if (plan === null) me.planAt = 0
  me.plan = plan
  if (activity) me.activity = clip(activity, 60)
  isDirty = true
}

async function readGoal($: EngineInterface): Promise<void> {
  if (me === null) return
  try {
    const path = `${home}/.claude/mods-data/goal-meter/${me.id}.json`
    if (!(await $.fs.exists(path))) return
    const counts = goalPlan(JSON.parse(await $.fs.read(path)))
    if (counts !== null) setPlan(counts, 'goal', await $.clock.now(), '')
  } catch {
    // Goal Meter's own band still shows it
  }
}

async function startTurn($: EngineInterface, text: string): Promise<void> {
  if (me === null) return
  await followClear($)
  const at = await $.clock.now()
  const plan: Plan | null = me.plan !== null && me.plan.done < me.plan.total ? me.plan : null
  if (plan === null) tasks.clear()
  me = {
    ...me,
    state: 'working',
    startedAt: at,
    endedAt: 0,
    waitMs: 0,
    waitingSince: 0,
    tools: 0,
    activity: 'Thinking',
    need: '',
    plan,
    planAt: plan === null ? 0 : me.planAt,
    expectMs: expectedMs(pace, myTurns),
    stopPct: 0,
    agents: 0,
  }
  waitKind = ''
  heardStartAt = at
  notWorkingSince = 0
  isSettledEarly = false
  if (titleFrom === 'folder') {
    const title = titleFromPrompt(text)
    if (title) {
      me.title = title
      titleFrom = 'prompt'
    }
  }
  await readGoal($)
  await writeSelf($)
}

async function beginWait($: EngineInterface, kind: 'ask' | 'permission', need: string): Promise<void> {
  if (me === null || me.state !== 'working') return
  me.state = 'waiting'
  me.waitingSince = await $.clock.now()
  me.need = need
  if (kind === 'permission') me.activity = 'Waiting for your permission'
  waitKind = kind
  await writeSelf($)
}

async function endWait($: EngineInterface): Promise<void> {
  waitKind = ''
  if (me === null || me.state !== 'waiting') return
  const at = await $.clock.now()
  me.waitMs += Math.max(0, at - me.waitingSince)
  me.waitingSince = 0
  me.state = 'working'
  me.need = ''
  await writeSelf($)
}

// A row settled while its turn was still running (the engine's band said idle
// during a long wait) is live again the moment the turn shows activity.
function reviveSettled(): void {
  if (me === null || !isSettledEarly || me.state !== 'done') return
  isSettledEarly = false
  notWorkingSince = 0
  me = { ...me, state: 'working', endedAt: 0, turns: Math.max(0, me.turns - 1), stopPct: 0 }
}

async function noteCall($: EngineInterface, tool: string, input: Record<string, unknown>, isMain: boolean, isAsk: boolean): Promise<void> {
  reviveSettled()
  notWorkingSince = 0
  if (me === null || !isLiveState(me.state)) return
  // A tool runs once its permission was given.
  if (waitKind === 'permission') await endWait($)
  const at = await $.clock.now()
  me.tools += 1
  if (isMain) {
    const activity = activityOf(tool, input)
    if (activity) me.activity = activity
  }
  if (tool === 'TodoWrite') {
    const found = todosPlan(input.todos)
    setPlan(found === null ? null : found.counts, 'todos', at, found === null ? '' : found.activity)
  } else if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? '')
    const prev = tasks.get(id)
    if (id) {
      tasks.set(id, {
        status: typeof input.status === 'string' ? input.status : (prev?.status ?? 'pending'),
        label: typeof input.activeForm === 'string' ? input.activeForm : (prev?.label ?? ''),
      })
      const found = tasksPlan(tasks)
      setPlan(found === null ? null : found.counts, 'tasks', at, found === null ? '' : found.activity)
    }
  } else if (tool === SAVVY_PROGRESS || tool === SAVVY_STEP) {
    setPlan(savvyPlan(input, me.plan), 'savvy', at, typeof input.note === 'string' ? input.note : '')
  }
  isDirty = true
  if (isAsk) await beginWait($, 'ask', askNeed(tool, input))
}

function taskIdOf(ran: ToolCallResult): string {
  const result = ran.result as { task?: { id?: unknown }; taskId?: unknown; id?: unknown } | undefined
  const direct = result?.task?.id ?? result?.taskId ?? result?.id
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct)
  const text = (ran as { text?: unknown }).text
  const found = /#?(\d+)/.exec(typeof text === 'string' ? text : '')
  return found?.[1] ?? ''
}

async function afterCall($: EngineInterface, tool: string, input: Record<string, unknown>, ran: ToolCallResult, isAsk: boolean): Promise<void> {
  if (me === null) return
  if (isAsk || waitKind === 'permission') await endWait($)
  if (tool === 'TaskCreate' && ran.deny === undefined) {
    const id = taskIdOf(ran)
    if (id) {
      tasks.set(id, { status: 'pending', label: String(input.activeForm ?? input.subject ?? '') })
      const found = tasksPlan(tasks)
      setPlan(found === null ? null : found.counts, 'tasks', await $.clock.now(), '')
    }
  }
  if (tool === GOAL_TOOL) await readGoal($)
}

async function finishTurn($: EngineInterface, reason: string, durationMs: number): Promise<void> {
  reviveSettled()
  if (me === null || me.startedAt === 0 || !isLiveState(me.state)) return
  const at = await $.clock.now()
  if (me.waitingSince) {
    me.waitMs += Math.max(0, at - me.waitingSince)
    me.waitingSince = 0
  }
  const pct = estimate(me, at).pct
  const took = durationMs > 0 ? durationMs : at - me.startedAt
  const state: PulseState = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'error'
  me = { ...me, state, endedAt: at, turns: me.turns + 1, lastMs: took, stopPct: pct, activity: '', need: '' }
  waitKind = ''
  if (state === 'done') {
    const worked = Math.max(SEC, took - me.waitMs)
    myTurns = [...myTurns, worked].slice(-10)
    if (worked > 3 * SEC) await recordPace($, worked)
  }
  try {
    const running = (await $.agent.list()).filter(a => a.status === 'running').length
    me.agents = running
    if (running > 0) me.activity = `${running} background agent${running === 1 ? '' : 's'} still running`
  } catch {
    me.agents = 0
  }
  await writeSelf($)
  if (titleFrom !== 'desktop' || me.turns <= 3) await refreshTitle($)
}

// A turn whose end this module never heard (a reload or an unload between its
// start and its end) would stay "working" for good. The engine's own band says
// whether a turn runs: past a short grace, a live row with no turn running is
// over. Its length is unknown, so it teaches the pace nothing.
async function settleMissedTurn($: EngineInterface, isWorking: boolean): Promise<void> {
  if (isWorking) notWorkingSince = 0
  if (isWorking || me === null || me.startedAt === 0 || !isLiveState(me.state)) return
  const at = await $.clock.now()
  if (at - me.startedAt < MISSED_TURN_GRACE_MS) return
  // A turn this module saw start is still running while it waits on a long tool,
  // a workflow or background agents, whatever the engine's band says: settle it
  // only after a long quiet spell with nothing running.
  const isHeard = me.startedAt === heardStartAt
  if (isHeard) {
    if (notWorkingSince === 0) notWorkingSince = at
    if (at - notWorkingSince < HEARD_TURN_GRACE_MS) return
    try {
      if ((await $.agent.list()).some(a => a.status === 'running')) return
    } catch {
      // no agent list: go by the quiet spell alone
    }
  }
  isSettledEarly = isHeard
  me = { ...me, state: 'done', endedAt: at, turns: me.turns + 1, stopPct: 100, waitingSince: 0, activity: '', need: '' }
  waitKind = ''
  await writeSelf($)
}

// ---------------------------------------------------------------------------
// Everyone else: read their heartbeats, notice who finished or needs you

async function scan($: EngineInterface, at: number): Promise<void> {
  if (me === null || !dir) return
  let entries: readonly { name: string; kind: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    entries = []
  }
  const beats: Beat[] = []
  const old: string[] = []
  const seen = new Set<string>()
  hidden.clear()
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const beatName = BEAT_FILE.exec(entry.name)
    const hideName = beatName === null ? HIDE_FILE.exec(entry.name) : null
    if (beatName === null && hideName === null) continue
    seen.add(entry.name)
    const path = `${dir}/${entry.name}`
    let cached = files.get(entry.name)
    if (cached === undefined || cached.mtimeMs !== entry.mtimeMs) {
      cached = { mtimeMs: entry.mtimeMs, beat: null, hiddenAt: 0 }
      try {
        const raw: unknown = JSON.parse(await $.fs.read(path))
        if (beatName !== null) cached.beat = asBeat(raw)
        else cached.hiddenAt = typeof (raw as { at?: unknown })?.at === 'number' ? (raw as { at: number }).at : 0
      } catch {
        cached.mtimeMs = -1 // caught mid-write: read it again next time
      }
      files.set(entry.name, cached)
    }
    if (hideName !== null) {
      if (cached.hiddenAt > 0) hidden.set(hideName[1] ?? '', cached.hiddenAt)
      else if (cached.mtimeMs > 0 && at - cached.mtimeMs > FORGET_MS) old.push(path)
      continue
    }
    const beat = cached.beat
    if (beat === null || beat.id === me.id) continue
    if (beat.ended === true || at - beat.updatedAt > FORGET_MS) {
      old.push(path)
      continue
    }
    beats.push(beat)
  }
  for (const name of [...files.keys()]) if (!seen.has(name)) files.delete(name)
  if (at < demoUntil) beats.push(...demo.map(b => ({ ...b, updatedAt: at })))
  else demo = []

  const others: Row[] = beats.map(b => ({
    ...b,
    isSelf: false,
    isHidden: isDemo(b.id) ? demoHidden.has(b.id) : isHiddenBeat(b, hidden.get(b.id) ?? 0),
    isStale: at - b.updatedAt > STALE_MS,
  }))
  const self = selfRow()
  const next = (self === null ? others : [...others, self]).sort(byBirth)
  await alert($, next)
  const before = await read($, rowsAtom)
  if (JSON.stringify(before) !== JSON.stringify(next)) await update($, rowsAtom, () => next)
  if (old.length > 0 && at - lastPrune > 10 * MIN) {
    lastPrune = at
    await prune($, old)
  }
}

async function prune($: EngineInterface, paths: readonly string[]): Promise<void> {
  const safe = paths.filter(p => p.startsWith(`${dir}/`) && /\/(s|hide)-[A-Za-z0-9-]{8,64}\.json$/.test(p))
  if (safe.length === 0) return
  try {
    await $.process.run(['rm', '-f', '--', ...safe], { timeoutMs: 5000 })
  } catch {
    // they stay off the board either way
  }
}

async function alert($: EngineInterface, list: readonly Row[]): Promise<void> {
  const prefs = await read($, prefsAtom)
  const isMasked = await read($, maskedAtom)
  list.forEach((r, i) => {
    const before = lastState.get(r.id)
    lastState.set(r.id, r.state)
    if (!hasScanned || !prefs.alerts || r.isSelf || r.isHidden || r.isStale || before === undefined || before === r.state) return
    const name = clip(labelOf(r, i, isMasked), 48)
    if (r.state === 'done' && isLiveState(before)) $.ui.toast(`✓ ${name} finished · took ${durText(r.lastMs)}`)
    else if (r.state === 'waiting') $.ui.toast(`● ${name} needs you`)
    else if (r.state === 'error') $.ui.toast(`✗ ${name} stopped on an error`)
  })
  hasScanned = true
}

// ---------------------------------------------------------------------------
// Acting on a row: switch to it, hide it

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

async function switchTo($: EngineInterface, row: Row, surface: RenderSurface): Promise<void> {
  if (row.isSelf) {
    $.ui.toast('This is the session you are in.')
    return
  }
  if (isDemo(row.id)) {
    $.ui.toast(`Demo row: a real "${clip(row.title, 40)}" session would open here.`)
    return
  }
  if (HOST_ID.test(row.hostId)) {
    const url = `claude://code/continue?session=${row.hostId}`
    for (const argv of [['open', url], ['xdg-open', url]]) {
      try {
        const ran = await $.process.run(argv, { timeoutMs: 8000 })
        if (ran.exitCode === 0) return
      } catch {
        // try the next opener
      }
    }
    $.ui.toast('Could not open that session in the desktop app.')
    return
  }
  const resume = `cd ${shellQuote(row.cwd)} && claude --resume ${row.id}`
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text: resume, surface })).isCopied
  } catch {
    isCopied = false
  }
  $.ui.toast(isCopied ? 'That session runs in a terminal. Its resume command is on the clipboard.' : `That session runs in a terminal: ${resume}`, { timeoutMs: 8000 })
}

async function hideRow($: EngineInterface, row: Row): Promise<void> {
  if (isDemo(row.id)) {
    demoHidden.add(row.id)
    await update($, rowsAtom, list => list.map(r => (r.id === row.id ? { ...r, isHidden: true } : r)))
    return
  }
  if (!dir) return
  const at = await $.clock.now()
  try {
    await $.fs.write(hidePath(row.id), JSON.stringify({ at }))
  } catch {
    // hidden in this session only
  }
  hidden.set(row.id, at)
  await update($, rowsAtom, list => list.map(r => (r.id === row.id ? { ...r, isHidden: true } : r)))
}

async function unhideAll($: EngineInterface): Promise<number> {
  const ids = [...hidden.keys()]
  for (const id of ids) {
    try {
      await $.fs.write(hidePath(id), JSON.stringify({ at: 0 }))
    } catch {
      // stays hidden until its next turn
    }
  }
  const count = ids.length + demoHidden.size
  hidden.clear()
  demoHidden.clear()
  await update($, rowsAtom, list => list.map(r => ({ ...r, isHidden: false })))
  return count
}

async function openPane($: EngineInterface): Promise<void> {
  // Docked beside the transcript where the surface docks panes (the right side).
  await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true, columns: 72 })
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

// ---------------------------------------------------------------------------
// Drawing

// A dark tint of a state color, for the terminal's one-row chip behind its word.
function chipTint(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (m === null) return '#2a2a2a'
  const mix = (h: string | undefined): string => Math.round(0x22 + (parseInt(h ?? '0', 16) - 0x22) * 0.18).toString(16).padStart(2, '0')
  return `#${mix(m[1])}${mix(m[2])}${mix(m[3])}`
}

function viewOf(r: Row, at: number): View {
  const est = estimate(r, at)
  let pct = est.pct
  if (isLiveState(r.state)) {
    // Never step backwards while one turn runs (a plan appearing can lower the estimate).
    const key = `${r.id}:${r.startedAt}`
    pct = Math.max(pct, highest.get(key) ?? 0)
    if (highest.size > 300) highest.clear()
    highest.set(key, pct)
  }
  const color = colorOf(r.state, pct)
  const pctText = r.state === 'idle' ? '' : `${Math.round(pct)}%`
  const base = { pct, pctText, color, isLive: r.state === 'working', tailHex: '' }
  // The time column says when (time left, or how long ago); the state column
  // after it says what it is, or, while the session waits on you, what to do.
  const time = (tail: string) => ({ tail, tailColor: 'subtle' })
  const state = (word: string, c = 'subtle') => ({ state: word, stateColor: c })
  switch (r.state) {
    case 'working':
      return { ...base, ...time(etaText(est.etaMs)), ...state('working', color) }
    case 'waiting':
      return { ...base, ...time(`${durText(Math.max(0, at - (r.waitingSince || at)))} waiting`), ...state(r.need || 'needs you', COLOR.waiting) }
    case 'done':
      return { ...base, ...time(agoText(at - r.endedAt)), ...state('done', COLOR.done) }
    case 'stopped':
      return { ...base, ...time(agoText(at - r.endedAt)), ...state('interrupted', COLOR.stopped) }
    case 'error':
      return { ...base, ...time(agoText(at - r.endedAt)), ...state('error', COLOR.error) }
    default:
      return { ...base, ...time(''), ...state(r.isStale ? 'offline' : 'idle', COLOR.idle) }
  }
}

function termRow($: EngineInterface, ui: Kit, item: Item, at: number, cols: number, hotkey: string, need: Need): RenderElement {
  const { Box, Text, Button } = ui
  const r = item.row
  const view = viewOf(r, at)
  // The title column fits the longest title shown; the bar gives up room first
  // (down to 10 cells) and a title is cut only past half the row.
  // The alert column fits the longest shown whole, on one line.
  const tailW = clamp(need.tail, 6, 14)
  const paneW = clamp(need.state, 4, 32) + 1
  const titleW = clamp(need.title, 10, Math.max(10, Math.min(Math.floor(cols * 0.5), cols - 18 - tailW - paneW - 10)))
  const barW = clamp(cols - titleW - 18 - tailW - paneW, 6, 32)
  const { fill, rest } = barCells(view.pct, barW)
  const name = fit(r.isSelf ? `${item.label} (here)` : item.label, titleW)
  const keys = hotkey ? { hotkey } : {}
  return (
    <Box key={`row-${r.id}`} flexDirection="row" width="100%" gap={1}>
      <Box width={ICON_CELLS - 1} flexShrink={0}>
        <Text color={view.color}>{iconOf(r.state)}</Text>
      </Box>
      <Button key={`go-${r.id}`} plain {...keys} onPress={press => void switchTo($, r, press.surface)}>
        <Text bold={r.isSelf}>{name}</Text>
      </Button>
      <Box flexDirection="row">
        <Text color={view.color}>{fill}</Text>
        <Text color="subtle">{rest}</Text>
      </Box>
      <Text bold>{view.pctText.padStart(4)}</Text>
      <Text color={view.tailColor}>{fit(view.tail, tailW)}</Text>
      {r.state === 'waiting' ? <Text color={COLOR.waiting}>{fit(view.state, paneW - 1)}</Text> : <Text dimColor>{fit(view.state, paneW - 1)}</Text>}
      <Box flexGrow={1} />
      <Button key={`x-${r.id}`} label="×" plain dimColor onPress={() => void hideRow($, r)} />
    </Box>
  )
}

function svgRow($: EngineInterface, ui: Kit, Svg: SvgElement, item: Item, at: number, cols: number, hotkey: string, site: string, need: Need): RenderElement {
  const { Box, Text, Button } = ui
  const r = item.row
  const view = viewOf(r, at)
  // The row is laid out in the band's columns (about 8 CSS px each; the app's
  // text runs about 0.85 of a column per character), so it never runs past the
  // band's right edge. The title and time-left columns fit the longest of each
  // shown; the buttons take their own width; the bar gets the rest, down to 10
  // columns, and a title is cut only past half the row.
  const span = clamp(cols, 40, 220)
  const PCT = 4
  // The alert column gets room to spare (0.95 of a column a character, plus
  // two), so a "needs you" phrase always fits whole on one line.
  // Time, then state (or what to do), each as wide as its longest shown, whole on one line.
  const TIME = Math.max(4, Math.ceil(need.tail * 0.95) + 1)
  // The state column, its longest word whole on one line.
  const PANE = Math.max(4, Math.ceil(need.state * 0.95) + 1)
  const TAIL = TIME
  const BUTTONS = 6 // ↗ and ×: their labels plus the buttons' padding
  const GAPS = 7
  const FIXED = PCT + TAIL + PANE + BUTTONS + GAPS + 2
  // The pane has no band to share: a title may take up to two thirds of its row.
  const share = site.endsWith(':pane') ? 0.65 : 0.5
  const maxTitle = Math.max(10, Math.min(Math.floor(span * share), span - FIXED - 10))
  const titleCells = clamp(Math.ceil(need.title * 0.9) + 3, 10, maxTitle)
  const titleChars = Math.floor((titleCells - 3) / 0.9)
  const barCells = Math.max(8, span - titleCells - FIXED)
  // The bar and, at its right end, the rolling percent in the app's own glyphs.
  const width = (barCells + 1 + PCT) * 8
  const keys = hotkey ? { hotkey } : {}
  const name = item.label
  const shownKey = `${site}:${r.id}`
  const before = lastShown.get(shownKey)
  if (lastShown.size > 300) lastShown.clear()
  lastShown.set(shownKey, { pct: view.pct, pctText: view.pctText })
  const source = barSvg({
    pct: view.pct,
    color: view.color,
    width,
    pctText: view.pctText,
    prevPct: before?.pct,
    prevPctText: before !== undefined && before.pctText !== view.pctText ? before.pctText : '',
    tail: '',
    tailColor: '',
    isLive: view.isLive,
    font: digitFont,
    pctW: PCT * 8,
  })
  return (
    <Box key={`row-${r.id}`} flexDirection="row" alignItems="center" width="100%" gap={1}>
      {/* The dot and the title are one plain line of text, drawn as the
          status line above draws "● cache warm", so both line up with it
          exactly (a button's own padding would push the title right). The ↗
          before the × switches to the session. No wrap prop (the desktop draws
          a wrapped text larger): the title is cut instead. */}
      <Box width={titleCells} flexShrink={0} flexDirection="row" alignItems="center">
        <Text>
          <Text color={view.color}>{iconOf(r.state)}</Text>
          <Text dimColor>{` ${cells(name) <= titleChars ? name : clip(name, Math.max(8, titleChars))}`}</Text>
        </Text>
      </Box>
      {/* The bar starts right after the title column, so it always sits
          between the title and its percent; spare room goes before the ×. */}
      <Svg source={source} alt={`${name}: ${[view.pctText, view.tail].filter(Boolean).join(', ')}`} width={width} height={SVG_HEIGHT} />
      {/* Time, then state (or what to do while it waits on you), each column
          as wide as its longest shown, so the × buttons line up row to row. */}
      <Box width={TAIL} flexShrink={0}>
        <Text color={view.tailColor}>{view.tail}</Text>
      </Box>
      {/* The state in dim text; what to do, while it waits on you, in blue. */}
      <Box width={PANE} flexShrink={0}>
        {r.state === 'waiting' ? <Text color={COLOR.waiting}>{view.state}</Text> : <Text dimColor>{view.state}</Text>}
      </Box>
      <Box flexGrow={1} />
      <Button key={`go-${r.id}`} label="↗" plain dimColor {...keys} onPress={press => void switchTo($, r, press.surface)} />
      <Button key={`x-${r.id}`} label="×" plain dimColor onPress={() => void hideRow($, r)} />
    </Box>
  )
}

// The terminal draws text bars; the desktop and the other remote surfaces an
// SVG bar. The surface decides, not the table: the terminal's carries an Svg too.
function rowOf($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, surface: RenderSurface, item: Item, at: number, cols: number, hotkey: string, site: string, need: Need): RenderElement {
  return surface !== 'terminal' && 'Svg' in ui ? svgRow($, ui, ui.Svg, item, at, cols, hotkey, `${surface}:${site}`, need) : termRow($, ui, item, at, cols, hotkey, need)
}

// The cells the longest shown title, time and state need, so every row's
// columns are as wide as their widest entry and nothing is cut while the row has room.
type Need = { title: number; tail: number; state: number }

function columnNeeds(items: readonly Item[], surface: RenderSurface, at: number): Need {
  return items.reduce(
    (a, x) => ({
      title: Math.max(a.title, cells(surface === 'terminal' && x.row.isSelf ? `${x.label} (here)` : x.label)),
      tail: Math.max(a.tail, cells(viewOf(x.row, at).tail)),
      state: Math.max(a.state, cells(viewOf(x.row, at).state)),
    }),
    { title: 0, tail: 0, state: 0 },
  )
}

function compactBand($: EngineInterface, ui: Kit, surface: RenderSurface, items: readonly Item[], at: number): RenderElement {
  const { Box, Text, Button } = ui
  const views = items.map(x => ({ row: x.row, view: viewOf(x.row, at), est: estimate(x.row, at) }))
  const working = views.filter(v => v.row.state === 'working')
  const waiting = views.filter(v => v.row.state === 'waiting')
  const finished = views.filter(v => v.row.state === 'done')
  const failed = views.filter(v => v.row.state === 'error' || v.row.state === 'stopped')
  const parts: RenderElement[] = []
  if (working.length > 0) {
    const avg = working.reduce((a, v) => a + v.view.pct, 0) / working.length
    const soonest = Math.min(...working.map(v => v.est.etaMs ?? Infinity))
    const next = Number.isFinite(soonest) ? ` · next ${etaText(soonest)}` : ''
    parts.push(<Text color={workingColor(avg)}>{`● ${working.length} working${next}`}</Text>)
  }
  if (waiting.length > 0) parts.push(<Text color={COLOR.waiting}>{`● ${waiting.length} need${waiting.length === 1 ? 's' : ''} you`}</Text>)
  if (finished.length > 0) parts.push(<Text color={COLOR.done}>{`✓ ${finished.length} done`}</Text>)
  if (failed.length > 0) parts.push(<Text color={COLOR.stopped}>{`■ ${failed.length} stopped`}</Text>)
  const children: (RenderElement | string)[] = []
  parts.forEach((p, i) => {
    if (i > 0) children.push('   ')
    children.push(p)
  })
  // A desktop button insets its label and drops the colors, so off the
  // terminal the line is plain text that starts where the band's other text does.
  if (surface !== 'terminal') {
    return (
      <Box flexDirection="row" width="100%">
        {children}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" width="100%">
      <Button key="pulse-open" plain onPress={() => void openPane($)}>
        {children}
      </Button>
    </Box>
  )
}

function stateWord(r: Row): string {
  switch (r.state) {
    case 'working':
      return 'Working'
    case 'waiting':
      return 'Needs you'
    case 'done':
      return 'Done'
    case 'stopped':
      return 'Interrupted'
    case 'error':
      return 'Stopped on an error'
    default:
      return 'Idle'
  }
}

// The second line of a pane row: what the session is doing or how its last
// turn went, then the plan, the folder and where it runs.
function detailOf(r: Row, at: number, isMasked: boolean): string {
  const since = (t: number): string => durText(Math.max(0, at - t))
  const activity = !isMasked && r.activity ? r.activity : ''
  let lead: string
  if (r.isStale) lead = `No heartbeat for ${since(r.updatedAt)}, probably closed`
  else if (r.state === 'working') lead = `${activity || 'Working'} · ${since(r.startedAt)} so far${r.plan === null ? ' · time left estimated from past turns' : ''}`
  else if (r.state === 'waiting') lead = `Needs you: ${r.need || (activity ? activity.replace(/^Waiting for /, '') : 'your answer')} · waiting ${since(r.waitingSince || r.startedAt)}`
  else if (r.state === 'done') lead = `Finished ${agoText(at - r.endedAt)} · took ${durText(r.lastMs)}`
  else if (r.state === 'stopped') lead = `Interrupted ${agoText(at - r.endedAt)}`
  else if (r.state === 'error') lead = `Stopped on an error ${agoText(at - r.endedAt)}`
  else lead = r.turns > 0 ? `Idle since ${agoText(at - r.endedAt)}` : 'Open, no prompt yet'
  const parts = [lead]
  if (r.plan !== null) {
    parts.push(r.plan.source === 'goal' ? `goal ${Math.round((100 * r.plan.done) / r.plan.total)}% done` : `${r.plan.done} of ${r.plan.total} tasks done`)
  }
  if (r.agents > 0 && !isLiveState(r.state)) parts.push(`${r.agents} background agent${r.agents === 1 ? '' : 's'} running`)
  if (!isMasked && r.project) parts.push(r.project)
  parts.push(r.hostId ? 'Desktop app' : 'Terminal')
  return parts.join(' · ')
}

function boardText(list: readonly Row[], at: number, isMasked: boolean): string {
  const live = list.filter(r => r.ended !== true)
  if (live.length === 0) return 'No sessions on the board.'
  return live
    .map((r, i) => {
      const view = viewOf(r, at)
      return `${iconOf(r.state)} ${labelOf(r, i, isMasked)}${r.isSelf ? ' (here)' : ''}  ${view.pctText} ${view.tail}`.trimEnd()
    })
    .join('\n')
}

const HELP = [
  '/pulse: open or close the session board.',
  '/pulse compact | full | off: one summary line, a row per session, or no band.',
  '/pulse alerts on | off: a toast when another session finishes or needs you.',
  '/pulse show: bring hidden rows back.',
  '/pulse name <title>: rename this session on the board.',
  '/pulse demo [off]: five made-up sessions for three minutes, to see every state.',
].join('\n')

async function runCommand($: EngineInterface, args: string): Promise<CommandRunResult> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const word = verb.toLowerCase()
  if (word === '') {
    if ((await $.session.surfaces()).length === 0) {
      return { text: boardText(await read($, rowsAtom), await $.clock.now(), await read($, maskedAtom)) }
    }
    const isOpen = await togglePane($)
    return isOpen ? {} : { text: 'Session board closed.' }
  }
  if (word === 'full' || word === 'compact' || word === 'off') {
    const mode: Prefs['mode'] = word
    await savePrefs($, p => ({ ...p, mode }))
    return { text: mode === 'off' ? 'Session band off. /pulse still opens the board.' : `Session band: ${mode}.` }
  }
  if (word === 'alerts') {
    const value = (rest[0] ?? '').toLowerCase()
    const isOn = value === 'on' ? true : value === 'off' ? false : !(await read($, prefsAtom)).alerts
    await savePrefs($, p => ({ ...p, alerts: isOn }))
    return { text: `Session alerts ${isOn ? 'on' : 'off'}.` }
  }
  if (word === 'show') {
    const count = await unhideAll($)
    return { text: count === 0 ? 'No hidden sessions.' : `Showing ${count} hidden session${count === 1 ? '' : 's'} again.` }
  }
  if (word === 'demo') {
    const at = await $.clock.now()
    demoHidden.clear()
    if ((rest[0] ?? '').toLowerCase() === 'off') {
      demo = []
      demoUntil = 0
      await saveDemo($, 0)
      await scan($, at)
      return { text: 'Demo rows removed.' }
    }
    demo = demoBeats(at)
    demoUntil = at + 3 * MIN
    await saveDemo($, at)
    await scan($, at)
    return { text: 'Five demo sessions for three minutes (/pulse demo off ends it). Clicks and × work on them; nothing is written.' }
  }
  if (word === 'name') {
    const title = clip(rest.join(' ').trim(), 80)
    if (me === null) return { text: 'This session is not on the board.' }
    if (!title) {
      titleFrom = 'folder'
      me.title = ''
      await refreshTitle($)
    } else {
      titleFrom = 'name'
      me.title = title
    }
    await writeSelf($)
    return { text: title ? `This session is "${title}" on the board.` : 'Board title reset.' }
  }
  return { text: HELP }
}

const COMMAND_DESCRIPTION = 'Session board: every open session with progress and time left'
const COMMAND_HINT = '[compact|full|off|alerts on|off|show|name <title>|demo]'

// /pulse, or /session-pulse when another plugin took the short name.
async function registerCommand($: EngineInterface): Promise<string> {
  try {
    await $.command.register({ name: 'pulse', description: COMMAND_DESCRIPTION, argumentHint: COMMAND_HINT, immediate: true })
    return 'pulse'
  } catch {
    try {
      await $.command.register({ name: 'session-pulse', description: COMMAND_DESCRIPTION, argumentHint: COMMAND_HINT, immediate: true })
      return 'session-pulse'
    } catch {
      return ''
    }
  }
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      home = (await $.env.get('HOME')) ?? ''
      if (!home) return started
      dir = home + DATA
      const host = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? ''
      hostId = HOST_ID.test(host) ? host : ''
      await readSettings($)
      commandName = await registerCommand($)
      // A headless child (claude -p) has no surface and stays off the board; a
      // desktop session may attach its surface after it starts.
      // A hot reload in an already attached session raises no new attach, so
      // the surfaces already drawing count too.
      const surfaces = await $.session.surfaces()
      if (e.isInteractive || e.surface !== null || surfaces.length > 0) {
        await startTracking($, e.cwd, e.surface ?? surfaces[0] ?? 'terminal')
      }
    } catch {
      // the board stays empty in this session
    }
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    try {
      if (!isTracked && dir) await startTracking($, await $.session.cwd(), e.surface)
      else if (me !== null && e.surface !== 'terminal' && me.surface !== e.surface) {
        me.surface = e.surface
        isDirty = true
      }
    } catch {
      // tracking starts on the next attach
    }
    return attached
  })

  on('turn.start', async ($, e, next) => {
    try {
      await startTurn($, e.text)
    } catch {
      // the row catches up on the next heartbeat
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isAsk = e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode'
    try {
      await noteCall($, e.tool, input, e.agentId === undefined, isAsk)
    } catch {
      // bookkeeping only
    }
    const ran = await next(e)
    try {
      await afterCall($, e.tool, input, ran, isAsk)
    } catch {
      // bookkeeping only
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      await beginWait($, 'permission', permissionNeed(e.tool_name))
    } catch {
      // bookkeeping only
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    try {
      if (e.notification_type === 'permission_prompt') await beginWait($, 'permission', 'allow tool')
      else if (e.notification_type === 'elicitation_dialog') await beginWait($, 'permission', 'fill in form')
    } catch {
      // bookkeeping only
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    try {
      await endWait($)
    } catch {
      // bookkeeping only
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      if (e.agentId === undefined) await finishTurn($, e.reason, e.durationMs)
    } catch {
      // the row catches up on the next heartbeat
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    try {
      if (me !== null) {
        await writeEnded($, me)
        if (e.reason === 'clear') me.ended = true
        else me = null
      }
    } catch {
      // the file goes stale and drops off
    }
    return next(e)
  })

  on('command.run', { command: ['pulse', 'session-pulse'] }, async ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.isWorking === false) void settleMissedTurn($, false).catch(() => undefined)
    if (e.props.hasSurvey || !isTracked) return below
    const prefs = await read($, prefsAtom)
    if (prefs.mode === 'off') return below
    const list = (await read($, rowsAtom)).filter(r => r.ended !== true)
    const tickAt = await read($, nowAtom)
    const isMasked = await read($, maskedAtom)
    const at = Math.max(tickAt, ...list.map(r => r.updatedAt))
    const items: Item[] = list.map((row, i) => ({ row, label: labelOf(row, i, isMasked) }))
    const onBand = items.filter(x => isOnBand(x.row, at))
    if (onBand.length === 0) return below

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    let mine: RenderElement
    if (prefs.mode === 'compact') {
      mine = compactBand($, ui, e.surface, onBand, at)
    } else {
      // Sessions the pane lists and the band leaves out; this one never counts.
      const more = items.filter(x => !x.row.isSelf).length - onBand.slice(0, BAND_ROWS).filter(x => !x.row.isSelf).length
      const need = columnNeeds(onBand.slice(0, BAND_ROWS), e.surface, at)
      mine = (
        <Box flexDirection="column">
          {onBand.slice(0, BAND_ROWS).map(x => rowOf($, ui, e.surface, x, at, e.props.bodyColumns, '', 'band', need))}
          {/* The last line: "+N more" at the left, the pane button at the right
              end, under the rows' × buttons. */}
          <Box flexDirection="row" width="100%" gap={1}>
            {more > 0 &&
              (e.surface === 'terminal' ? (
                <Button key="pulse-more" plain dimColor onPress={() => void openPane($)}>
                  {`+${more} more session${more === 1 ? '' : 's'} · /${commandName || 'pulse'}`}
                </Button>
              ) : (
                <Text color="subtle">{`+${more} more session${more === 1 ? '' : 's'} · /${commandName || 'pulse'}`}</Text>
              ))}
            <Box flexGrow={1} />
            {/* Not plain: the app draws its own framed button around the word
                (the terminal draws [ pane ]). */}
            <Button key="pulse-pane" label="pane" dimColor onPress={() => void togglePane($)} />
          </Box>
        </Box>
      )
    }
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = (await read($, rowsAtom)).filter(r => r.ended !== true)
    const tickAt = await read($, nowAtom)
    const isMasked = await read($, maskedAtom)
    const prefs = await read($, prefsAtom)
    const at = Math.max(tickAt, ...list.map(r => r.updatedAt))
    const items: Item[] = list.map((row, i) => ({ row, label: labelOf(row, i, isMasked) }))
    const groups: { title: string; items: Item[] }[] = [
      { title: 'Running', items: items.filter(x => !x.row.isHidden && !x.row.isStale && isLiveState(x.row.state)) },
      { title: 'Finished', items: items.filter(x => !x.row.isHidden && !x.row.isStale && (x.row.state === 'done' || x.row.state === 'stopped' || x.row.state === 'error')) },
      { title: 'Idle', items: items.filter(x => !x.row.isHidden && !x.row.isStale && x.row.state === 'idle') },
      // A closed session needs no hiding: it is offline whatever was pressed.
      { title: 'Offline', items: items.filter(x => x.row.isStale) },
      { title: 'Hidden', items: items.filter(x => x.row.isHidden && !x.row.isStale) },
    ].filter(g => g.items.length > 0)
    const hiddenCount = items.filter(x => x.row.isHidden && !x.row.isStale).length
    const live = items.filter(x => !x.row.isStale)
    const counts = [
      [live.filter(x => x.row.state === 'working').length, 'working'],
      [live.filter(x => x.row.state === 'waiting').length, 'need you'],
      [live.filter(x => x.row.state === 'done' || x.row.state === 'stopped' || x.row.state === 'error').length, 'finished'],
      [live.filter(x => x.row.state === 'idle').length, 'idle'],
      [items.length - live.length, 'offline'],
    ] as const
    const summary = counts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${count === 1 && word === 'need you' ? 'needs you' : word}`).join(' · ')
    const cols = e.props.bodyColumns
    const need = columnNeeds(items, e.surface, at)
    return (
      <Box flexDirection="column">
        {/* The count and the summary share one line that never wraps; the
            controls sit under them, short enough for a narrow pane. */}
        <Box flexDirection="row" width="100%" gap={1}>
          <Text bold wrap="truncate-end">{`${items.length} session${items.length === 1 ? '' : 's'}`}</Text>
          {summary !== '' && <Text color="subtle" wrap="truncate-end">{`· ${summary}`}</Text>}
        </Box>
        <Box flexDirection="row" width="100%" gap={2}>
          <Button key="pulse-mode" plain dimColor onPress={() => void savePrefs($, p => ({ ...p, mode: p.mode === 'full' ? 'compact' : p.mode === 'compact' ? 'off' : 'full' }))}>
            {`Band: ${prefs.mode}`}
          </Button>
          <Button key="pulse-alerts" plain dimColor onPress={() => void savePrefs($, p => ({ ...p, alerts: !p.alerts }))}>
            {`Alerts: ${prefs.alerts ? 'on' : 'off'}`}
          </Button>
          {hiddenCount > 0 && (
            <Button key="pulse-unhide" plain dimColor onPress={() => void unhideAll($)}>
              {`Unhide ${hiddenCount}`}
            </Button>
          )}
        </Box>
        {items.length === 0 && <Text color="subtle">No sessions yet. Each open session joins the board when it starts.</Text>}
        {groups.map(g => (
          <Box key={`group-${g.title}`} flexDirection="column" marginTop={1}>
            <Text color="subtle">{g.title}</Text>
            {g.items.map(x => {
              return (
                <Box key={`item-${x.row.id}`} flexDirection="column">
                  {rowOf($, ui, e.surface, x, at, cols, '', 'pane', need)}
                  <Box flexDirection="row">
                    {e.surface === 'terminal' && <Box width={ICON_CELLS} flexShrink={0} />}
                    <Text color="subtle" wrap="truncate-end">{detailOf(x.row, at, isMasked)}</Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color="subtle" wrap="truncate-end">{`Click a title to switch · × hides · /${commandName || 'pulse'} help`}</Text>
        </Box>
      </Box>
    )
  })
}

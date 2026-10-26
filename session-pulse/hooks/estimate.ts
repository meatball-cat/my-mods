// Session Pulse's math and text: how far along a session is, how long it has
// left, and how a row reads. Pure functions with no mods API calls, so the
// tests drive them directly.

import type { Beat, Plan, PulseState } from '../types'

export const SEC = 1000
export const MIN = 60 * SEC
export const HOUR = 60 * MIN

/** A turn's length before anything has been learned. */
export const DEFAULT_TURN_MS = 90 * SEC
const MIN_EXPECT = 15 * SEC
const MAX_EXPECT = 2 * HOUR

export const STATES: readonly PulseState[] = ['working', 'waiting', 'done', 'stopped', 'error', 'idle']

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const finite = (n: unknown, fallback = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback)

export function median(list: readonly number[]): number {
  const s = list.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (s.length === 0) return 0
  const m = Math.floor(s.length / 2)
  const mid = s[m] ?? 0
  return s.length % 2 ? mid : ((s[m - 1] ?? mid) + mid) / 2
}

// ---------------------------------------------------------------------------
// Progress and time left

/**
 * How long the next turn should take: this session's last five turns
 * (geometric mean), pulled toward every session's median, harder the fewer
 * turns this one has had.
 */
export function expectedMs(all: readonly number[], mine: readonly number[]): number {
  const global = median(all) || DEFAULT_TURN_MS
  const recent = mine.filter(n => Number.isFinite(n) && n > 0).slice(-5)
  if (recent.length === 0) return clamp(global, MIN_EXPECT, MAX_EXPECT)
  const own = Math.exp(recent.reduce((a, d) => a + Math.log(Math.max(d, SEC)), 0) / recent.length)
  const w = recent.length / (recent.length + 2)
  return Math.round(clamp(Math.exp(w * Math.log(own) + (1 - w) * Math.log(global)), MIN_EXPECT, MAX_EXPECT))
}

/** Time the turn has spent working; waits on the person don't count. */
export function workedMs(b: Beat, now: number): number {
  const waiting = b.waitingSince ? Math.max(0, now - b.waitingSince) : 0
  return Math.max(0, now - b.startedAt - b.waitMs - waiting)
}

export type Estimate = {
  /** 0 to 100; 100 only once the turn is done. */
  pct: number
  /** Rough time left, or null when nothing is running. */
  etaMs: number | null
  basis: 'plan' | 'pace' | 'final'
}

export function estimate(b: Beat, now: number): Estimate {
  if (b.state === 'done') return { pct: 100, etaMs: null, basis: 'final' }
  if (b.state === 'idle') return { pct: 0, etaMs: null, basis: 'final' }
  if (b.state === 'stopped' || b.state === 'error') {
    return { pct: clamp(Math.round(b.stopPct), 0, 99), etaMs: null, basis: 'final' }
  }
  const expect = Math.max(b.expectMs || DEFAULT_TURN_MS, MIN_EXPECT)
  if (b.plan !== null && b.plan.total >= 2) return planEstimate(b.plan, b, now, expect)

  // No plan: a curve over the expected length. At the expected length the bar
  // shows two thirds; it slows as the turn runs long and stays under 100
  // until the turn ends.
  const worked = workedMs(b, now)
  const pct = 95 * (1 - Math.exp((-1.2 * worked) / expect))
  // A turn past its expected length is likely a long one: what is left grows with it.
  const etaMs = Math.max(expect - worked, 0.5 * worked, 5 * SEC)
  return { pct: clamp(pct, 1, 95), etaMs, basis: 'pace' }
}

function planEstimate(plan: Plan, b: Beat, now: number, expect: number): Estimate {
  const total = plan.total
  const done = clamp(plan.done, 0, total)
  const since = b.planAt || b.startedAt
  // The pace per task so far; before the first task is done, the expected turn
  // split across the plan.
  const spent = Math.max(0, plan.changedAt - since)
  const per = done >= 1 && spent > 0 ? Math.max(spent / done, 5 * SEC) : Math.max(expect / total, 20 * SEC)
  // A task in progress creeps toward done as its expected time passes.
  const active = clamp(plan.active, 0, total - done)
  const creep = Math.min(0.9, 1 - Math.exp(-Math.max(0, now - plan.changedAt) / per))
  const units = done + active * creep
  const pct = clamp((100 * units) / total, 1, 99)
  return { pct, etaMs: Math.max(per * Math.max(total - units, 0.1), 5 * SEC), basis: 'plan' }
}

/**
 * The expected length and time worked that put a plan-less turn at `pct` with
 * about `etaMs` left: the pace curve run backwards, for `/pulse demo`.
 */
export function demoTiming(pct: number, etaMs: number): { expectMs: number; workedMs: number } {
  const x = -Math.log(1 - clamp(pct, 1, 94) / 95) / 1.2
  // Up to two thirds of the expected length what is left is the rest of it;
  // past that, half the time worked.
  const expectMs = x <= 2 / 3 ? etaMs / (1 - x) : etaMs / (0.5 * x)
  return { expectMs: Math.round(expectMs), workedMs: Math.round(x * expectMs) }
}

// ---------------------------------------------------------------------------
// Plans

type PlanCounts = { done: number; active: number; total: number }

/** A plan with `changedAt` kept when the counts did not move. */
export function withChange(prev: Plan | null, next: PlanCounts, source: string, now: number): Plan | null {
  if (next.total < 1) return null
  const isSame = prev !== null && prev.done === next.done && prev.active === next.active && prev.total === next.total
  return { ...next, source, changedAt: isSame ? prev.changedAt : now }
}

/** TodoWrite's list: its counts and the item in progress. */
export function todosPlan(todos: unknown): { counts: PlanCounts; activity: string } | null {
  if (!Array.isArray(todos) || todos.length === 0) return null
  let done = 0
  let active = 0
  let activity = ''
  for (const t of todos) {
    const item = (t ?? {}) as { status?: unknown; activeForm?: unknown; content?: unknown }
    if (item.status === 'completed') done += 1
    if (item.status === 'in_progress') {
      active += 1
      if (!activity) activity = clip(oneLine(str(item.activeForm) || str(item.content)), 60)
    }
  }
  return { counts: { done, active, total: todos.length }, activity }
}

export type TaskEntry = { status: string; label: string }

/** The Task tools' list (TaskCreate, TaskUpdate), kept by the session as it sees the calls. */
export function tasksPlan(tasks: ReadonlyMap<string, TaskEntry>): { counts: PlanCounts; activity: string } | null {
  const live = [...tasks.values()].filter(t => t.status !== 'deleted')
  if (live.length === 0) return null
  const active = live.filter(t => t.status === 'in_progress')
  return {
    counts: { done: live.filter(t => t.status === 'completed').length, active: active.length, total: live.length },
    activity: active[0]?.label ?? '',
  }
}

type GoalTask = { status?: unknown; size?: unknown; replaced?: unknown }
const SIZE: Record<string, number> = { S: 1, M: 2, L: 3 }

/** Goal Meter's plan file for this session, weighted by task size as Goal Meter weighs it. */
export function goalPlan(raw: unknown): PlanCounts | null {
  const g = (raw ?? {}) as { status?: unknown; tasks?: unknown }
  if (g.status !== 'running' || !Array.isArray(g.tasks)) return null
  const live = (g.tasks as GoalTask[]).filter(t => t && !t.replaced && t.status !== 'dropped')
  if (live.length === 0) return null
  const w = (t: GoalTask): number => SIZE[String(t.size ?? 'M').toUpperCase()] ?? 2
  return {
    done: live.filter(t => t.status === 'done').reduce((a, t) => a + w(t), 0),
    active: live.filter(t => t.status === 'active').reduce((a, t) => a + w(t), 0),
    total: live.reduce((a, t) => a + w(t), 0),
  }
}

/** savvy-progress's `progress` and `step` calls. */
export function savvyPlan(input: Record<string, unknown>, prev: Plan | null): PlanCounts | null {
  const total = Math.round(finite(input.total, prev?.total ?? 0))
  if (total < 1) return null
  if (input.finished === true) return { done: total, active: 0, total }
  const done = clamp(Math.round(finite(input.done, prev?.done ?? 0)), 0, total)
  return { done, active: done < total ? 1 : 0, total }
}

// ---------------------------------------------------------------------------
// What a session is doing, from its tool calls

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, Math.max(1, max - 1)).join('') + '…' : s
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function activityOf(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `Editing ${basename(str(input.file_path))}`
    case 'NotebookEdit':
      return `Editing ${basename(str(input.notebook_path))}`
    case 'Read':
      return `Reading ${basename(str(input.file_path))}`
    case 'Bash': {
      const what = oneLine(str(input.description))
      if (what) return clip(what, 60)
      const head = oneLine(str(input.command)).split(' ').slice(0, 3).join(' ')
      return clip(`Running ${head}`, 60)
    }
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
      return 'Searching'
    case 'WebFetch':
    case 'WebSearch':
      return 'Researching the web'
    case 'Agent':
    case 'Task': {
      const what = oneLine(str(input.description))
      return what ? clip(`Delegating: ${what}`, 60) : 'Running a subagent'
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer'
    case 'ExitPlanMode':
      return 'Waiting for plan approval'
    case 'Skill':
      return str(input.skill) ? clip(`Using skill ${str(input.skill)}`, 60) : 'Using a skill'
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
      return ''
  }
  if (tool.startsWith('mcp__')) {
    const name = tool.split('__').slice(2).join('__') || tool.slice(5)
    return clip(`Using ${name.replace(/_/g, ' ')}`, 60)
  }
  return clip(`Using ${tool}`, 60)
}

/**
 * What a waiting session needs from you, in two or three words: the tool it
 * asks to run, the question it asks, the plan it wants approved.
 */
export function permissionNeed(tool: string): string {
  const name: Record<string, string> = {
    Bash: 'bash',
    Edit: 'edit',
    MultiEdit: 'edit',
    Write: 'write',
    NotebookEdit: 'notebook edit',
    WebFetch: 'web fetch',
    WebSearch: 'web search',
    Read: 'read',
    Agent: 'subagent',
    Task: 'subagent',
  }
  if (name[tool] !== undefined) return `allow ${name[tool]}`
  if (tool.startsWith('mcp__')) return clip(`allow ${(tool.split('__').slice(2).join(' ') || tool.slice(5)).replace(/_/g, ' ')}`, 30)
  return tool ? clip(`allow ${tool.toLowerCase()}`, 30) : 'allow tool'
}

export function askNeed(tool: string, input: Record<string, unknown>): string {
  if (tool === 'ExitPlanMode') return 'approve plan'
  const first = Array.isArray(input.questions) ? (input.questions[0] as { header?: unknown } | undefined) : undefined
  const header = typeof first?.header === 'string' ? oneLine(first.header) : ''
  return header ? clip(`pick ${header.toLowerCase()}`, 30) : 'answer question'
}

/** A board title from a prompt: its first line, one space between words. */
export function titleFromPrompt(text: string): string {
  const line = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
  if (line.startsWith('<')) return ''
  return clip(oneLine(line), 80)
}

// ---------------------------------------------------------------------------
// Reading another session's heartbeat safely

const ID = /^[A-Za-z0-9-]{8,64}$/
export const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/

/** A heartbeat read from disk, checked field by field; null when it is not one. */
export function asBeat(raw: unknown): Beat | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || typeof r.id !== 'string' || !ID.test(r.id)) return null
  const state = STATES.includes(r.state as PulseState) ? (r.state as PulseState) : 'idle'
  const p = r.plan as Record<string, unknown> | null | undefined
  const plan: Plan | null =
    p && typeof p === 'object' && finite(p.total) >= 1
      ? {
          done: Math.max(0, finite(p.done)),
          active: Math.max(0, finite(p.active)),
          total: finite(p.total),
          source: clip(str(p.source), 20),
          changedAt: finite(p.changedAt),
        }
      : null
  return {
    v: 1,
    id: r.id,
    hostId: HOST_ID.test(str(r.hostId)) ? str(r.hostId) : '',
    surface: clip(str(r.surface), 16),
    title: clip(oneLine(str(r.title)), 120),
    project: clip(str(r.project), 80),
    cwd: str(r.cwd).slice(0, 1024),
    state,
    bornAt: finite(r.bornAt),
    startedAt: finite(r.startedAt),
    endedAt: finite(r.endedAt),
    waitMs: Math.max(0, finite(r.waitMs)),
    waitingSince: Math.max(0, finite(r.waitingSince)),
    tools: Math.max(0, finite(r.tools)),
    activity: clip(oneLine(str(r.activity)), 80),
    plan,
    planAt: finite(r.planAt),
    expectMs: finite(r.expectMs, DEFAULT_TURN_MS),
    turns: Math.max(0, finite(r.turns)),
    lastMs: Math.max(0, finite(r.lastMs)),
    stopPct: clamp(finite(r.stopPct), 0, 100),
    agents: Math.max(0, finite(r.agents)),
    need: clip(oneLine(str(r.need)), 32),
    ended: r.ended === true,
    updatedAt: finite(r.updatedAt),
  }
}

// ---------------------------------------------------------------------------
// Text and color

export function durText(ms: number): string {
  // 59.6 s rounds to a minute, not to "60s".
  if (ms < MIN - SEC / 2) return `${Math.max(1, Math.round(ms / SEC))}s`
  const m = Math.round(ms / MIN)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h}h ${rest}m` : `${h}h`
}

/** The time-left label, `~30m` as the board shows it. */
export function etaText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  if (ms < MIN) return '<1m'
  return `~${durText(ms)}`
}

export function agoText(ms: number): string {
  return ms < MIN ? 'just now' : `${durText(ms)} ago`
}

// Muted throughout: no state color is far from grey, so the band reads calm.
export const COLOR = {
  done: '#4f9a72',
  waiting: '#6f9fd6',
  error: '#cf6a62',
  stopped: '#8e8e8e',
  idle: '#767676',
  track: '#3a3a3a',
} as const

function hex(n: number): string {
  return Math.round(clamp(n, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')
}

export function hsl(h: number, s: number, l: number): string {
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

/** Orange at the start, warming to yellow-green as the bar fills. */
/**
 * Light to deep as the bar fills: a pale straw yellow at the start, a soft
 * lime midway, a deep sage near the end, and the done green past it. Hue,
 * saturation and lightness move together, saturation kept low throughout.
 */
export function workingColor(pct: number): string {
  const t = clamp(pct, 0, 99) / 99
  return hsl(52 + t * 88, 0.58 - t * 0.2, 0.76 - t * 0.3)
}

export function colorOf(state: PulseState, pct: number): string {
  switch (state) {
    case 'working':
      return workingColor(pct)
    case 'waiting':
      return COLOR.waiting
    case 'done':
      return COLOR.done
    case 'error':
      return COLOR.error
    case 'stopped':
      return COLOR.stopped
    default:
      return COLOR.idle
  }
}

export function iconOf(state: PulseState): string {
  switch (state) {
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    case 'stopped':
      return '■'
    case 'idle':
      return '○'
    default:
      return '●'
  }
}

/** Cells a code point takes on a terminal: CJK and emoji take two. */
export function charCells(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  const isWide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  return isWide ? 2 : 1
}

export function cells(s: string): number {
  let n = 0
  for (const ch of s) n += charCells(ch.codePointAt(0) ?? 0)
  return n
}

/** Cut to `width` cells with an ellipsis, then pad with spaces to exactly `width`. */
export function fit(s: string, width: number): string {
  if (width <= 0) return ''
  if (cells(s) <= width) return s + ' '.repeat(width - cells(s))
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = charCells(ch.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + '…' + ' '.repeat(Math.max(0, width - used - 1))
}

/** A terminal bar: the filled part and the track, `width` cells in all. */
export function barCells(pct: number, width: number): { fill: string; rest: string } {
  const raw = Math.round((clamp(pct, 0, 100) / 100) * width)
  const n = pct > 0 ? clamp(raw, 1, width) : 0
  return { fill: '━'.repeat(n), rest: '━'.repeat(Math.max(0, width - n)) }
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"

const xml = (s: string): string =>
  s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)

export const SVG_HEIGHT = 22

// Rolling numbers: each changed digit is a strip of 0-9 behind a window that
// rolls from the old digit to the new one, odometer style; digits that kept
// their value stand still. SMIL, so it plays inside the SVG image.
//
// With the app's own glyphs (DigitFont, extracted from the Claude app's UI
// font by scripts/digits-from-app-font.py) the digits are drawn as outlines at
// the app's text size, so they match the band's text exactly; without them,
// as text in the system font.

export type DigitFont = {
  unitsPerEm: number
  capHeight: number
  glyphs: Record<string, { advance: number; path: string }>
}

/** The extracted glyph file, checked; null when it is not one. */
export function asDigitFont(raw: unknown): DigitFont | null {
  const f = raw as { unitsPerEm?: unknown; capHeight?: unknown; glyphs?: Record<string, { advance?: unknown; path?: unknown }> } | null
  if (f === null || typeof f !== 'object' || typeof f.unitsPerEm !== 'number' || typeof f.capHeight !== 'number' || f.glyphs === undefined) return null
  const glyphs: DigitFont['glyphs'] = {}
  const isGlyph = (g: { advance?: unknown; path?: unknown } | undefined): g is { advance: number; path: string } =>
    g !== undefined && typeof g.advance === 'number' && typeof g.path === 'string' && /^[MLHVQCZz0-9 .,-]*$/.test(g.path)
  // The digits and % are required; letters (for the state chips) are taken when present.
  for (const ch of '0123456789%') {
    const g = f.glyphs[ch]
    if (!isGlyph(g)) return null
    glyphs[ch] = { advance: g.advance, path: g.path }
  }
  for (const [ch, g] of Object.entries(f.glyphs)) {
    if ([...ch].length === 1 && glyphs[ch] === undefined && isGlyph(g)) glyphs[ch] = { advance: g.advance, path: g.path }
  }
  return { unitsPerEm: f.unitsPerEm, capHeight: f.capHeight, glyphs }
}

/**
 * A state chip styled as the app's hotkey keycap (the handoff button's H): a
 * rounded rectangle a shade off the background with a thin border, no color,
 * sized to the word
 * and to the row (18px tall in a 22px row); grey as the band's dim text, in
 * either theme. Drawn in the app's own glyphs when every letter is there, else
 * in the system font. (`color` is kept for a coloured variant; unused.)
 */
export function chipSvg(word: string, color: string, font: DigitFont | null): { source: string; width: number; height: number } {
  const H = 18
  const PAD = 7
  const size = 12
  void color
  const hasGlyphs = font !== null && [...word].every(ch => ch === ' ' || font.glyphs[ch] !== undefined)
  let inner: string
  let textW: number
  if (hasGlyphs && font !== null) {
    const k = size / font.unitsPerEm
    const baseline = H / 2 + (font.capHeight * k) / 2
    let x = PAD
    const uses: string[] = []
    for (const ch of word) {
      const g = font.glyphs[ch]
      if (g !== undefined && g.path) uses.push(`<path d="${g.path}" transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${k} ${-k})"/>`)
      x += (g?.advance ?? font.unitsPerEm * 0.3) * k
    }
    textW = x - PAD
    inner = `<g class="c">${uses.join('')}</g>`
  } else {
    textW = cells(word) * size * 0.56
    inner = `<text class="c" x="${PAD}" y="${H / 2 + 4}" font-family="${FONT}" font-size="${size}">${xml(word)}</text>`
  }
  const W = Math.ceil(textW + PAD * 2)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.c{fill:#7f7d78}.b{stroke:#d3d1cc;fill:#f3f2ef}
@media (prefers-color-scheme: dark){.c{fill:#9a9893}.b{stroke:#4a4a48;fill:#272727}}</style>
<rect class="b" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="4"/>
${inner}
</svg>`
  return { source, width: W, height: H }
}

/** The app's text size in the band, measured against its own font. */
export const APP_TEXT_PX = 13
const DIGIT_W = 8
const ROW_H = 18
const ROLL = 'dur="0.6s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1"'

export function rollingNumber(text: string, prev: string, right: number, H: number, font: DigitFont | null = null): string {
  const m = /^(\d+)(.*)$/.exec(text)
  if (font !== null && m !== null && [...text].every(ch => font.glyphs[ch] !== undefined)) return rollingGlyphs(text, prev, right, H, font)
  const baseline = H / 2 + 5
  const plain = (x: number, ch: string, anchor = 'middle'): string =>
    `<text class="t" x="${x}" y="${baseline}" text-anchor="${anchor}" font-family="${FONT}" font-size="13">${xml(ch)}</text>`
  if (m === null) return text ? plain(right, text, 'end') : ''
  const digits = m[1] ?? ''
  const suffix = m[2] ?? ''
  const suffixW = suffix ? 10 : 0
  const was = (/^(\d+)/.exec(prev)?.[1] ?? '').padStart(digits.length, ' ').slice(-digits.length)
  const x0 = right - suffixW - digits.length * DIGIT_W
  const top = H / 2 - ROW_H / 2
  const parts: string[] = [`<defs><clipPath id="win"><rect x="${x0 - 1}" y="${top}" width="${digits.length * DIGIT_W + 2}" height="${ROW_H}"/></clipPath></defs>`]
  const rolls: string[] = []
  ;[...digits].forEach((ch, i) => {
    const cx = x0 + i * DIGIT_W + DIGIT_W / 2
    const from = was[i] ?? ' '
    if (prev === '' || from === ch) {
      parts.push(plain(cx, ch))
      return
    }
    const strip = Array.from({ length: 10 }, (_, d) =>
      `<text class="t" x="${cx}" y="${baseline + d * ROW_H}" text-anchor="middle" font-family="${FONT}" font-size="13">${d}</text>`).join('')
    const start = from === ' ' ? ROW_H : -Number(from) * ROW_H
    const end = -Number(ch) * ROW_H
    rolls.push(`<g transform="translate(0 ${end})"><animateTransform attributeName="transform" type="translate" from="0 ${start}" to="0 ${end}" ${ROLL}/>${strip}</g>`)
  })
  if (rolls.length) parts.push(`<g clip-path="url(#win)">${rolls.join('')}</g>`)
  if (suffix) parts.push(plain(right, suffix, 'end'))
  return parts.join('')
}

// The same roll with the app's glyph outlines: each glyph defined once, used
// by reference, scaled to the app's text size and centred on the bar's line.
function rollingGlyphs(text: string, prev: string, right: number, H: number, font: DigitFont): string {
  const k = APP_TEXT_PX / font.unitsPerEm
  const baseline = H / 2 + (font.capHeight * k) / 2
  const advance = (ch: string): number => (font.glyphs[ch]?.advance ?? 0) * k
  const m = /^(\d+)(.*)$/.exec(text)
  const digits = m?.[1] ?? ''
  const suffix = m?.[2] ?? ''
  const was = (/^(\d+)/.exec(prev)?.[1] ?? '').padStart(digits.length, ' ').slice(-digits.length)
  const isRolling = prev !== '' && [...digits].some((ch, i) => (was[i] ?? ' ') !== ch)
  const used = new Set(isRolling ? '0123456789' + suffix : text)
  const defs = [...used].map(ch => `<path id="g${ch === '%' ? 'p' : ch}" d="${font.glyphs[ch]?.path ?? ''}"/>`).join('')
  const use = (ch: string, x: number, y: number): string =>
    `<use href="#g${ch === '%' ? 'p' : ch}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k} ${-k})"/>`
  const total = [...text].reduce((a, ch) => a + advance(ch), 0)
  let x = right - total
  const top = H / 2 - ROW_H / 2
  const parts: string[] = []
  const rolls: string[] = []
  for (const [i, ch] of [...digits].entries()) {
    const w = advance(ch)
    const from = was[i] ?? ' '
    if (prev === '' || from === ch) {
      parts.push(use(ch, x, baseline))
    } else {
      // A strip of 0-9 down the slot, each glyph centred in it.
      const strip = Array.from({ length: 10 }, (_, d) => use(String(d), x + (w - advance(String(d))) / 2, baseline + d * ROW_H)).join('')
      const start = from === ' ' ? ROW_H : -Number(from) * ROW_H
      const end = -Number(ch) * ROW_H
      rolls.push(`<g transform="translate(0 ${end})"><animateTransform attributeName="transform" type="translate" from="0 ${start}" to="0 ${end}" ${ROLL}/>${strip}</g>`)
    }
    x += w
  }
  for (const ch of suffix) {
    parts.push(use(ch, x, baseline))
    x += advance(ch)
  }
  const clip = rolls.length ? `<clipPath id="win"><rect x="${right - total - 1}" y="${top}" width="${total + 2}" height="${ROW_H}"/></clipPath>` : ''
  return `<defs>${defs}${clip}</defs><g class="d">${parts.join('')}${rolls.length ? `<g clip-path="url(#win)">${rolls.join('')}</g>` : ''}</g>`
}

/**
 * A desktop bar: a rounded track, the fill, the percent and the time left dim,
 * as the board's mock-up draws them. Light and dark theme alike. Given what
 * the last drawing showed (`prevPct`, `prevPctText`), the fill grows from its
 * old length and the changed digits roll to their new values.
 */
export function barSvg(o: { pct: number; color: string; width: number; pctText: string; prevPct?: number; prevPctText?: string; tail: string; tailColor: string; isLive: boolean; isBarOnly?: boolean; font?: DigitFont | null; pctW?: number }): string {
  const W = Math.max(120, Math.round(o.width))
  const H = SVG_HEIGHT
  // Bar only: the percent and time left are drawn as text beside the picture.
  // No tail given: the time left is drawn as text beside the picture.
  const tailW = o.isBarOnly === true || o.tail === '' ? 0 : 64
  const pctW = o.isBarOnly === true ? 0 : (o.pctW ?? 48)
  const barW = o.isBarOnly === true ? W : Math.max(40, W - tailW - pctW - (tailW === 0 ? 8 : 12))
  const barH = 8
  const y = (H - barH) / 2
  const widthOf = (pct: number): number => (pct > 0 ? Math.max(barH, Math.round((barW * clamp(pct, 0, 100)) / 100)) : 0)
  const fillW = widthOf(o.pct)
  const fromW = o.prevPct === undefined ? fillW : widthOf(o.prevPct)
  const grow = fromW !== fillW ? `<animate attributeName="width" from="${fromW}" to="${fillW}" ${ROLL}/>` : ''
  // An inline style, since the theme class would win over a fill attribute.
  const tailStyle = /^#[0-9a-f]{6}$/i.test(o.tailColor) ? ` style="fill:${o.tailColor}"` : ' class="m"'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.k{fill:#e2e2df}.t{fill:#1f1f1f}.m{fill:#8a8a86}.d{fill:#7f7d78}
@media (prefers-color-scheme: dark){.k{fill:#3a3a3a}.t{fill:#f4f4f2}.m{fill:#8f8f8b}.d{fill:#898782}}
.p{animation:pl 1.8s ease-in-out infinite}@keyframes pl{50%{opacity:.6}}
@media (prefers-reduced-motion: reduce){.p{animation:none}}</style>
<rect class="k" x="0" y="${y}" width="${barW}" height="${barH}" rx="${barH / 2}"/>
${fillW ? `<rect${o.isLive ? ' class="p"' : ''} x="0" y="${y}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="${o.color}">${grow}</rect>` : ''}
${o.isBarOnly === true ? '' : rollingNumber(o.pctText, o.prevPctText ?? '', barW + 8 + pctW, H, o.font ?? null)}
${o.isBarOnly === true ? '' : `<text${tailStyle} x="${W}" y="${H / 2 + 5}" text-anchor="end" font-family="${FONT}" font-size="13" font-variant-numeric="tabular-nums">${xml(o.tail)}</text>`}
</svg>`
}

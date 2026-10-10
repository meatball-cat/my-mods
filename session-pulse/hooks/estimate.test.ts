import { describe, expect, test } from 'claude-code/testing'

import type { Beat } from '../types'
import {
  DEFAULT_TURN_MS,
  MIN,
  SEC,
  asBeat,
  askNeed,
  permissionNeed,
  barCells,
  asDigitFont,
  barSvg,
  rollingNumber,
  cells,
  demoTiming,
  estimate,
  etaText,
  expectedMs,
  fit,
  goalPlan,
  savvyPlan,
  tasksPlan,
  titleFromPrompt,
  todosPlan,
  withChange,
  workingColor,
} from './estimate'

const T0 = 1_800_000_000_000

function beat(over: Partial<Beat> = {}): Beat {
  return {
    v: 1,
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    hostId: '',
    surface: 'terminal',
    title: 'Fix login bug',
    project: 'app',
    cwd: '/work/app',
    state: 'working',
    bornAt: T0,
    startedAt: T0,
    endedAt: 0,
    waitMs: 0,
    waitingSince: 0,
    tools: 0,
    activity: '',
    plan: null,
    planAt: 0,
    expectMs: 10 * MIN,
    turns: 0,
    lastMs: 0,
    stopPct: 0,
    agents: 0,
    updatedAt: T0,
    ...over,
  }
}

describe('expected turn length', () => {
  test('starts from a default and learns', () => {
    expect(expectedMs([], [])).toBe(DEFAULT_TURN_MS)
    expect(expectedMs([60 * SEC, 120 * SEC, 180 * SEC], [])).toBe(120 * SEC)
    // A session with long turns pulls its own estimate up from the global one.
    const mine = expectedMs([60 * SEC], [20 * MIN, 20 * MIN, 20 * MIN])
    expect(mine).toBeGreaterThan(5 * MIN)
    expect(mine).toBeLessThan(20 * MIN)
  })
})

describe('progress without a plan', () => {
  test('rises over the expected length, never reaches 100 while working', () => {
    const b = beat()
    const early = estimate(b, T0 + 30 * SEC)
    const half = estimate(b, T0 + 5 * MIN)
    const due = estimate(b, T0 + 10 * MIN)
    const late = estimate(b, T0 + 60 * MIN)
    expect(early.pct).toBeLessThan(half.pct)
    expect(half.pct).toBeLessThan(due.pct)
    expect(due.pct).toBeGreaterThan(60)
    expect(due.pct).toBeLessThan(70)
    expect(late.pct).toBeLessThanOrEqual(95)
    expect(half.etaMs).toBe(5 * MIN)
    expect(late.basis).toBe('pace')
    // Past its expected length, what is left grows with the turn.
    expect(late.etaMs ?? 0).toBeGreaterThan(20 * MIN)
  })

  test('time spent waiting on the person does not count', () => {
    const b = beat({ state: 'waiting', waitingSince: T0 + 2 * MIN })
    expect(estimate(b, T0 + 9 * MIN).pct).toBe(estimate(beat(), T0 + 2 * MIN).pct)
  })

  test('done is 100, stopped keeps where it stopped, idle is empty', () => {
    expect(estimate(beat({ state: 'done' }), T0).pct).toBe(100)
    expect(estimate(beat({ state: 'stopped', stopPct: 41.6 }), T0).pct).toBe(42)
    expect(estimate(beat({ state: 'idle' }), T0)).toEqual({ pct: 0, etaMs: null, basis: 'final' })
  })
})

describe('demo timing', () => {
  test('puts a turn where the demo asks', () => {
    for (const [pct, eta] of [[72, 30 * MIN], [45, 12 * MIN], [88, 5 * MIN]] as const) {
      const t = demoTiming(pct, eta)
      const est = estimate(beat({ expectMs: t.expectMs }), T0 + t.workedMs)
      expect(Math.round(est.pct)).toBe(pct)
      expect(Math.abs((est.etaMs ?? 0) - eta)).toBeLessThan(SEC)
    }
  })
})

describe('progress from a plan', () => {
  test('counts finished tasks and creeps through the one in progress', () => {
    const plan = { done: 2, active: 1, total: 4, source: 'todos', changedAt: T0 + 4 * MIN }
    const b = beat({ plan, planAt: T0 })
    const at = estimate(b, T0 + 4 * MIN)
    const later = estimate(b, T0 + 5 * MIN)
    expect(at.basis).toBe('plan')
    expect(at.pct).toBe(50)
    expect(later.pct).toBeGreaterThan(50)
    expect(later.pct).toBeLessThan(75)
    // Two minutes a task so far, a little under two tasks left.
    expect(later.etaMs ?? 0).toBeGreaterThan(2 * MIN)
    expect(later.etaMs ?? 0).toBeLessThan(4 * MIN)
  })

  test('plans from the tools and mods it reads', () => {
    const todos = [
      { content: 'a', status: 'completed', activeForm: 'Doing a' },
      { content: 'b', status: 'in_progress', activeForm: 'Writing the newsletter' },
      { content: 'c', status: 'pending', activeForm: 'Doing c' },
    ]
    expect(todosPlan(todos)).toEqual({ counts: { done: 1, active: 1, total: 3 }, activity: 'Writing the newsletter' })
    expect(todosPlan([])).toBeNull()
    const tasks = new Map([
      ['1', { status: 'completed', label: '' }],
      ['2', { status: 'in_progress', label: 'Running tests' }],
      ['3', { status: 'deleted', label: '' }],
    ])
    expect(tasksPlan(tasks)).toEqual({ counts: { done: 1, active: 1, total: 2 }, activity: 'Running tests' })
    expect(goalPlan({ status: 'running', tasks: [{ status: 'done', size: 'L' }, { status: 'active', size: 'S' }, { status: 'dropped', size: 'L' }] })).toEqual({ done: 3, active: 1, total: 4 })
    expect(goalPlan({ status: 'met', tasks: [] })).toBeNull()
    expect(savvyPlan({ done: 2, total: 5 }, null)).toEqual({ done: 2, active: 1, total: 5 })
    expect(savvyPlan({ finished: true }, { done: 4, active: 1, total: 5, source: 'savvy', changedAt: 0 })).toEqual({ done: 5, active: 0, total: 5 })
  })

  test('keeps the change time when the counts did not move', () => {
    const first = withChange(null, { done: 1, active: 1, total: 3 }, 'todos', 100)
    expect(withChange(first, { done: 1, active: 1, total: 3 }, 'todos', 200)?.changedAt).toBe(100)
    expect(withChange(first, { done: 2, active: 1, total: 3 }, 'todos', 300)?.changedAt).toBe(300)
  })
})

describe('text', () => {
  test('time left reads like the mock-up', () => {
    expect(etaText(30 * MIN)).toBe('~30m')
    expect(etaText(45 * SEC)).toBe('<1m')
    expect(etaText(90 * MIN)).toBe('~1h 30m')
    expect(etaText(null)).toBe('')
  })

  test('fits wide characters by cells', () => {
    const s = fit('剪輯開場動畫', 8)
    expect(cells(s)).toBe(8)
    expect(s.includes('…')).toBe(true)
    expect(fit('Fix', 6)).toBe('Fix   ')
  })

  test('bars and colors', () => {
    expect(barCells(50, 10)).toEqual({ fill: '━━━━━', rest: '━━━━━' })
    expect(barCells(1, 10).fill).toBe('━')
    expect(workingColor(0)).toMatch(/^#[0-9a-f]{6}$/)
    expect(workingColor(0)).not.toBe(workingColor(95))
    const svg = barSvg({ pct: 72, color: '#f0a23b', width: 300, pctText: '72%', tail: '<1m', tailColor: '', isLive: true })
    expect(svg.includes('>7<') && svg.includes('>2<') && svg.includes('>%<')).toBe(true)
    expect(svg.includes('&lt;1m')).toBe(true)
  })

  test('only changed digits roll, and the bar grows from where it was', () => {
    expect(rollingNumber('72%', '', 100, 22).includes('animateTransform')).toBe(false)
    expect(rollingNumber('73%', '72%', 100, 22).split('animateTransform').length - 1).toBe(1)
    expect(rollingNumber('100%', '99%', 100, 22).split('animateTransform').length - 1).toBe(3)
    expect(rollingNumber('', '', 100, 22)).toBe('')
    const grown = barSvg({ pct: 60, prevPct: 50, color: '#91cb6b', width: 300, pctText: '60%', prevPctText: '50%', tail: '', tailColor: '', isLive: true })
    expect(grown.includes('attributeName="width"')).toBe(true)
    const still = barSvg({ pct: 60, prevPct: 60, color: '#91cb6b', width: 300, pctText: '60%', tail: '', tailColor: '', isLive: true })
    expect(still.includes('attributeName="width"')).toBe(false)
  })

  test('with the app glyphs, digits are drawn as outlines and roll the same way', () => {
    const glyphs = Object.fromEntries([...'0123456789%'].map(ch => [ch, { advance: 1000, path: 'M0 0H500V1400H0Z' }]))
    const font = asDigitFont({ unitsPerEm: 2000, capHeight: 1400, glyphs })
    expect(font).not.toBeNull()
    expect(asDigitFont({ unitsPerEm: 2000, capHeight: 1400, glyphs: { ...glyphs, '7': { advance: 1, path: '<script>' } } })).toBeNull()
    const still = rollingNumber('73%', '', 100, 22, font)
    expect(still.includes('<use')).toBe(true)
    expect(still.includes('<text')).toBe(false)
    expect(rollingNumber('73%', '72%', 100, 22, font).split('animateTransform').length - 1).toBe(1)
  })

  test('a waiting session says what it needs in a few words', () => {
    expect(permissionNeed('Bash')).toBe('allow bash')
    expect(permissionNeed('mcp__github__create_pull_request')).toBe('allow create pull request')
    expect(askNeed('ExitPlanMode', {})).toBe('approve plan')
    expect(askNeed('AskUserQuestion', { questions: [{ header: 'Auth method' }] })).toBe('pick auth method')
    expect(askNeed('AskUserQuestion', {})).toBe('answer question')
  })

  test('titles from prompts skip system text', () => {
    expect(titleFromPrompt('\n  Fix the   login bug\nmore')).toBe('Fix the login bug')
    expect(titleFromPrompt('<task-notification>done</task-notification>')).toBe('')
  })
})

describe('reading heartbeats', () => {
  test('rejects junk and cleans fields', () => {
    expect(asBeat(null)).toBeNull()
    expect(asBeat({ v: 1, id: '../../etc' })).toBeNull()
    const b = asBeat({ ...beat(), hostId: 'javascript:alert(1)', state: 'bogus', title: 'a\nb' })
    expect(b?.hostId).toBe('')
    expect(b?.state).toBe('idle')
    expect(b?.title).toBe('a b')
    expect(asBeat({ ...beat(), hostId: 'local_7962aaec-1c36' })?.hostId).toBe('local_7962aaec-1c36')
  })
})

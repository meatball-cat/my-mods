import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { checkingText, pointsOf, promptFor, spinnerAt, summaryOf } from './register'

type Fork = { isAnswered: true; text: string } | { isAnswered: false; reason: string }
type World = { forks: string[]; logs: string[]; toasts: string[]; fills: string[]; reply: { next: Fork } }

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function world(on: On, first: Fork): World {
  const w: World = { forks: [], logs: [], toasts: [], fills: [], reply: { next: first } }
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.fork', async ($, e) => {
    w.forks.push(e.prompt)
    const r = w.reply.next
    return { value: r.isAnswered ? { ...r, usage: USAGE } : { ...r, usage: USAGE } } as never
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', { component: 'AbovePrompt' }, (): RenderElement => ({ type: 'Box', children: [] }))
  return w
}

const BAND = {
  plugin: 'you-should-know',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

async function know($: Engine, args = ''): Promise<string | undefined> {
  const ran = await $.command.run({ command: 'you-should-know', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  return ran.text
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('pointsOf', () => {
  test('reads tagged lines and sorts them most urgent first', () => {
    expect(pointsOf('Here you go:\n- Changed | pricing.py rewritten | clamp added\n- Risk | Only test is skipped | "OK" is not a pass\n- Verify | Edge cases untested |\n')).toEqual([
      { tag: 'Risk', headline: 'Only test is skipped', detail: '"OK" is not a pass' },
      { tag: 'Verify', headline: 'Edge cases untested', detail: '' },
      { tag: 'Changed', headline: 'pricing.py rewritten', detail: 'clamp added' },
    ])
  })
  test('takes [Tag] and Tag: forms, and splits on a dash', () => {
    expect(pointsOf('- [todo] Docs not updated — README still old\n- Cost: Fork reads the whole chat')).toEqual([
      { tag: 'To do', headline: 'Docs not updated', detail: 'README still old' },
      { tag: 'Cost', headline: 'Fork reads the whole chat', detail: '' },
    ])
  })
  test('untagged lines become Notes', () => {
    expect(pointsOf('- tests were skipped')).toEqual([{ tag: 'Note', headline: 'tests were skipped', detail: '' }])
  })
  test('NOTHING means no points', () => {
    expect(pointsOf(' NOTHING. ')).toEqual([])
  })
  test('keeps at most 5', () => {
    expect(pointsOf(Array.from({ length: 8 }, (_, i) => `- Risk | p${i} |`).join('\n'))).toHaveLength(5)
  })
})

describe('summaryOf', () => {
  test('numbers each point with its tag', () => {
    const text = summaryOf({ focus: 'tests', at: 0, points: [{ tag: 'Risk', headline: 'Only test is skipped', detail: 'not a pass' }] })
    expect(text).toBe('You should know · tests (1)\n1. Risk     Only test is skipped — not a pass')
  })
})

describe('promptFor', () => {
  test('adds the focus only when given', () => {
    expect(promptFor('')).not.toContain('Focus on')
    expect(promptFor('tests')).toContain('Focus on: tests.')
  })
})

describe('the checking line', () => {
  test('the spinner cycles through its frames', () => {
    expect(spinnerAt(0)).toBe('⠋')
    expect(spinnerAt(1)).toBe('⠙')
    expect(spinnerAt(10)).toBe(spinnerAt(0))
  })
  test('shows the seconds so far', () => {
    expect(checkingText(7)).toBe(' · checking… 7s')
  })
})

describe('/you-should-know', () => {
  test('checks, shows the points above the prompt and logs them', async ($, on) => {
    const w = world(on, { isAnswered: true, text: '- Changed | pricing.py changed |\n- Risk | Only test is skipped | OK is not a pass' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    expect(await know($, 'tests')).toMatch(/Checking what you should know about tests/)
    await settle()
    expect(w.forks[0]).toContain('Focus on: tests.')
    expect(w.logs[0]).toContain('1. Risk     Only test is skipped — OK is not a pass')
    expect(w.logs[0]).toContain('2. Changed  pricing.py changed')
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /tests · 2 points/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Risk/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pricing\.py changed/ })).toBeDefined()
    await ui.press({ key: 'ysk-ask' })
    expect(w.fills[0]).toContain('- Risk: Only test is skipped — OK is not a pass')
    await ui.unmount()
  })

  test('says so when there is nothing to flag, and Understood clears it', async ($, on) => {
    world(on, { isAnswered: true, text: 'NOTHING' })
    await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
    await know($)
    await settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Nothing worth flagging/ })).toBeDefined()
    expect(await ui.find({ key: 'ysk-ask' })).toBeUndefined()
    await ui.press({ key: 'ysk-ok' })
    const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await after.find({ type: 'Text', text: /You should know/ })).toBeUndefined()
    await after.unmount()
    await ui.unmount()
  })

  test('toasts when there is nothing to fork yet', async ($, on) => {
    const w = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await know($)
    await settle()
    expect(w.toasts[0]).toMatch(/send a message first/)
    expect(w.logs).toHaveLength(0)
  })

  test('clear hides the last summary', async ($, on) => {
    world(on, { isAnswered: true, text: '- Risk | one thing |' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await know($)
    await settle()
    expect(await know($, 'clear')).toMatch(/cleared/)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /one thing/ })).toBeUndefined()
    await ui.unmount()
  })
})

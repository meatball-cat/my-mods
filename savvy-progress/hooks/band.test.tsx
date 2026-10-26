import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const

async function session($: Engine, on: On) {
  mock.clock(on, { now: Date.parse('2026-10-10T02:00:00Z') })
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('settings.read', async () => ({ value: {} }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
}

async function band($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface, ...BAND })
  const svg = await ui.findAll({ type: 'Svg' })
  const title = await ui.findAll({ type: 'Text', text: /^Ship it$/ })
  const label = await ui.findAll({ type: 'Text', text: /^Tasks 1\/4$/ })
  await ui.unmount()
  return { svg: svg.length, title: title.length, label: label.length }
}

test('terminal: the row draws the title, bar and label as text, not an Svg', async ($, on) => {
  await session($, on)
  expect(await band($, 'terminal')).toEqual({ svg: 0, title: 1, label: 1 })
})

test('desktop: the row is still one Svg', async ($, on) => {
  await session($, on)
  expect(await band($, 'desktop')).toEqual({ svg: 1, title: 0, label: 0 })
})

test('terminal: the count and percent keep their widest width, so the buttons stay put', async ($, on) => {
  await session($, on)
  await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Ship it', total: 10, done: 9, phase: 'delegate' } as never)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  const label = await ui.findAll({ type: 'Text', text: /^Tasks 9\/10 $/ })
  const pct = await ui.findAll({ type: 'Text', text: /^ 90%$/ })
  await ui.unmount()
  expect({ label: label.length, pct: pct.length }).toEqual({ label: 1, pct: 1 })
})

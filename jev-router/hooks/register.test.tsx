import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { hintFor, modelFor } from './register'

type World = { runs: string[][]; stdins: (string | undefined)[]; logs: string[]; contexts: (readonly string[] | undefined)[]; models: (string | undefined)[]; reply: { stdout: string; exitCode: number } }

function world(on: On, stdout: string, exitCode = 0, stored: Record<string, unknown> = {}): World {
  mock.store(on, stored)
  mock.clock(on)
  const w: World = { runs: [], stdins: [], logs: [], contexts: [], models: [], reply: { stdout, exitCode } }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    w.stdins.push(e.init?.stdin)
    return { value: { exitCode: w.reply.exitCode, stdout: w.reply.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    w.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Agent') w.models.push(e.model)
    return { result: 'done', text: 'done' } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, (): RenderElement => ({ type: 'Box', children: [] }))
  return w
}

const BAND = {
  plugin: 'jev-router',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

async function say($: Engine, text: string, kind: 'composer' | 'task-notification' = 'composer'): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind } } as never)
}

async function agent($: Engine, input: Record<string, unknown>): Promise<void> {
  await $.tool.call({ tool: 'Agent', description: 'task', prompt: 'do it', ...input } as never)
}

describe('hintFor', () => {
  test('passes a confident pick on', () => {
    expect(hintFor({ choice: 'docx', confidence: 0.93 })).toBe('Jev picked the docx skill (confidence 0.93).')
  })
  test('drops none, unsure picks and errors', () => {
    expect(hintFor({ choice: 'none', confidence: 1 })).toBeNull()
    expect(hintFor({ choice: 'docx', confidence: 0.59 })).toBeNull()
    expect(hintFor(null)).toBeNull()
  })
})

describe('modelFor', () => {
  test('maps 1 to haiku, 2-3 to sonnet, 4 to opus', () => {
    expect(modelFor({ score: 1, confidence: 0.9 })).toBe('haiku')
    expect(modelFor({ score: 2, confidence: 0.9 })).toBe('sonnet')
    expect(modelFor({ score: 3, confidence: 0.9 })).toBe('sonnet')
    expect(modelFor({ score: 4, confidence: 0.9 })).toBe('opus')
  })
  test('leaves the model alone when unsure or out of range', () => {
    expect(modelFor({ score: 4, confidence: 0.5 })).toBeNull()
    expect(modelFor({ score: 7, confidence: 1 })).toBeNull()
    expect(modelFor(null)).toBeNull()
  })
})

describe('skill routing', () => {
  test('adds a confident pick as context and logs it', async ($, on) => {
    const w = world(on, '{"choice": "docx", "confidence": 1.0}')
    await start($)
    await say($, 'Make me a Word doc')
    expect(w.runs[0]?.slice(-2)).toEqual(['--json', '-'])
    expect(w.stdins[0]).toBe('Make me a Word doc')
    expect(w.runs[0]?.[1]).toMatch(/scripts\/jev_skill_router\.py$/)
    expect(w.contexts[0]).toEqual(['Jev picked the docx skill (confidence 1.00).'])
    expect(w.logs).toEqual(['Jev → docx (1.00)'])
  })

  test('none adds and logs nothing', async ($, on) => {
    const w = world(on, '{"choice": "none", "confidence": 1.0}')
    await start($)
    await say($, 'hi')
    expect(w.contexts[0]).toBeUndefined()
    expect(w.logs).toEqual([])
  })

  test('fails open when the router errors, then pauses Jev', async ($, on) => {
    const w = world(on, '', 1)
    await start($)
    await say($, 'Make me a Word doc')
    await say($, 'Make me another')
    expect(w.contexts).toEqual([undefined, undefined])
    expect(w.logs).toEqual([])
    expect(w.runs).toHaveLength(1)
  })

  test('leaves notifications alone', async ($, on) => {
    const w = world(on, '{"choice": "docx", "confidence": 1.0}')
    await start($)
    await say($, 'task finished', 'task-notification')
    expect(w.runs).toEqual([])
  })

  test('the Skill line shows what Claude loaded beside the pick', async ($, on) => {
    const w = world(on, '{"choice": "docx", "confidence": 1.0}')
    await start($)
    await say($, 'Make me a Word doc')
    await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:docx' } as never)
    expect(w.logs[1]).toBe('Skill used: anthropic-skills:docx · Jev: docx (1.00)')
  })
})

describe('model routing', () => {
  test('sets the model from the complexity score', async ($, on) => {
    const w = world(on, '{"score": 1, "confidence": 0.99}')
    await start($)
    await agent($, { description: 'find files' })
    expect(w.runs[0]?.slice(-2)).toEqual(['--complexity', '-'])
    expect(w.stdins[0]).toBe('do it')
    expect(w.models).toEqual(['haiku'])
    expect(w.logs).toEqual(['Jev: subagent "find files" → haiku'])
  })

  test('never overrides an explicit model, a fork or a plugin agent type', async ($, on) => {
    const w = world(on, '{"score": 4, "confidence": 1.0}')
    await start($)
    await agent($, { model: 'sonnet' })
    await agent($, { subagent_type: 'fork' })
    await agent($, { subagent_type: 'savvy-flow:savvy-light' })
    expect(w.runs).toEqual([])
    expect(w.models).toEqual(['sonnet', undefined, undefined])
  })

  test('fails open when the router errors', async ($, on) => {
    const w = world(on, 'garbage')
    await start($)
    await agent($, {})
    expect(w.models).toEqual([undefined])
  })
})

describe('toggles', () => {
  test('/jev and /jev-model turn routing off, and Jev is not called', async ($, on) => {
    const w = world(on, '{"choice": "docx", "confidence": 1.0}')
    await start($)
    const opts = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
    expect((await $.command.run({ command: 'jev', args: '', ...opts })).text).toBe('Jev skill routing off')
    expect((await $.command.run({ command: 'jev-model', args: '', ...opts })).text).toBe('Jev model routing off')
    await say($, 'Make me a Word doc')
    await $.tool.call({ tool: 'Skill', skill: 'docx' } as never)
    await agent($, {})
    expect(w.runs).toEqual([])
    expect(w.logs).toEqual([])
  })

  test('the buttons flip their labels on every surface', async ($, on) => {
    world(on, '')
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const before = (await ui.find({ key: 'jev' }))?.props.label
      await ui.press({ key: 'jev' })
      await ui.press({ key: 'jev-model' })
      const after = await $.ui.mount({ ...BAND, surface })
      expect([before, (await after.find({ key: 'jev' }))?.props.label]).toEqual(
        before === 'Jev ● on' ? ['Jev ● on', 'Jev ○ off'] : ['Jev ○ off', 'Jev ● on'],
      )
      await after.unmount()
      await ui.unmount()
    }
  })

  test('the saved state is loaded at start', async ($, on) => {
    const w = world(on, '{"choice": "docx", "confidence": 1.0}', 0, { enabled: false, modelRouting: true })
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ key: 'jev' }))?.props.label).toBe('Jev ○ off')
    expect((await ui.find({ key: 'jev-model' }))?.props.label).toBe('Model ● on')
    await ui.unmount()
    await say($, 'Make me a Word doc')
    expect(w.runs).toEqual([])
  })
})

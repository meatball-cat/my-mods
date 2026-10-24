import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const HOME = '/home/u'
const DIR = `${HOME}/.claude/mods-data/session-pulse`
const ME = 'aaaaaaaa-0000-0000-0000-00000000000a'
const OTHER = 'bbbbbbbb-0000-0000-0000-00000000000b'
const T0 = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop'] as const

type World = { files: Map<string, { text: string; mtimeMs: number }>; runs: string[][]; toasts: string[]; opens: Record<string, unknown>[]; clock: MockClock }

// The engine beneath the mod: a clock, a store, an environment and a small
// file system in memory.
function world(on: On, env: Record<string, string> = { HOME }): World {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  mock.env(on, env)
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const runs: string[][] = []
  const toasts: string[] = []
  const opens: Record<string, unknown>[] = []
  let writes = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: ME }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.messages', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const file = files.get(e.path)
    return file === undefined ? { deny: `ENOENT ${e.path}` } : { value: file.text }
  })
  on('fs.write', ($, e) => {
    writes += 1
    files.set(e.path, { text: e.text, mtimeMs: T0 + writes })
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...files.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(([path, file]) => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })),
  }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opens.push({ ...e })
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: [] }))
  // The engine's own band with nothing in it.
  on('ui.render', { component: 'AbovePrompt' }, (): RenderElement => ({ type: 'Box', children: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  return { files, runs, toasts, opens, clock }
}

function otherBeat(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: OTHER,
    hostId: 'local_abc-123',
    surface: 'desktop',
    title: 'Write newsletter',
    project: 'news',
    cwd: '/work/news',
    state: 'working',
    bornAt: T0 - 60_000,
    startedAt: T0 - 60_000,
    endedAt: 0,
    waitMs: 0,
    waitingSince: 0,
    tools: 3,
    activity: 'Editing issue.md',
    plan: null,
    planAt: 0,
    expectMs: 120_000,
    turns: 1,
    lastMs: 90_000,
    stopPct: 0,
    agents: 0,
    updatedAt: T0,
    ...over,
  })
}

// A state shows as text in the terminal and as a chip picture (its alt the word) on desktop.
async function hasState(ui: { find: (q: { type?: string; text?: RegExp }) => Promise<unknown>; findAll: (q: { type?: string }) => Promise<{ props: Record<string, unknown> }[]> }, word: RegExp): Promise<boolean> {
  // The terminal wraps the word in brackets: [working].
  const texts = (await ui.findAll({ type: 'Text' })) as unknown as { text: string }[]
  if (texts.some(t => word.test(t.text.replace(/^\[|\]$/g, '')))) return true
  return (await ui.findAll({ type: 'Svg' })).some(svg => word.test(String(svg.props.alt ?? '')))
}

const BAND = {
  plugin: 'session-pulse',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}

const PANE = {
  plugin: 'session-pulse',
  component: 'Pane' as const,
  requestId: 'session-pulse',
  props: { title: 'Sessions', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat(), mtimeMs: T0 })
  await w.clock.advance(2000)
  await w.clock.settle()
}

describe('the band', () => {
  test('draws a row per live session and switches on a click', async ($, on) => {
    const w = world(on, { HOME, CLAUDE_CODE_HOST_SESSION_ID: 'local_me-1' })
    await start($, w)
    expect(w.files.has(`${DIR}/s-${ME}.json`)).toBe(true)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ key: `go-${OTHER}` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Write newsletter/ })).toBeDefined()
      if (surface === 'desktop') {
        expect(await ui.find({ type: 'Svg' })).toBeDefined()
        // The percent rolls inside the picture; the time left stays text.
        expect(await ui.find({ type: 'Text', text: /~\d+m|<1m/ })).toBeDefined()
      }
      else expect(await ui.find({ type: 'Text', text: /%/ })).toBeDefined()
      await ui.press({ key: `go-${OTHER}` })
      await ui.unmount()
    }
    expect(w.runs[0]).toEqual(['open', 'claude://code/continue?session=local_abc-123'])
  })

  test('x hides a row until that session starts another turn', async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: `x-${OTHER}` })
    expect(w.files.has(`${DIR}/hide-${OTHER}.json`)).toBe(true)
    expect(await ui.find({ key: `go-${OTHER}` })).toBeUndefined()
    // Its next turn brings it back.
    w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat({ startedAt: T0 + 60_000, updatedAt: T0 + 60_000 }), mtimeMs: T0 + 99 })
    await w.clock.advance(60_000)
    await w.clock.settle()
    expect(await ui.find({ key: `go-${OTHER}` })).toBeDefined()
    await ui.unmount()
  })

  test('a terminal session copies its resume command', async ($, on) => {
    const w = world(on)
    let copied = ''
    on('ui.copy', ($, e) => {
      copied = e.text
      return { value: { isCopied: true as const } }
    })
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat({ hostId: '', surface: 'terminal' }), mtimeMs: T0 })
    await w.clock.advance(2000)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: `go-${OTHER}` })
    expect(copied).toBe(`cd '/work/news' && claude --resume ${OTHER}`)
    expect(w.runs).toHaveLength(0)
    await ui.unmount()
  })

  test('the pane switches the band to one summary line', async ($, on) => {
    const w = world(on)
    await start($, w)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ key: `go-${OTHER}` })).toBeDefined()
    await pane.press({ key: 'pulse-mode' })
    await pane.unmount()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await band.find({ key: 'pulse-open' }))?.text ?? '').toMatch(/1 working/)
    await band.unmount()
  })
})

describe('the state column', () => {
  test('each row shows its state after the time, and what to do while it waits', async ($, on) => {
    const w = world(on)
    await start($, w)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await hasState(ui, /^\s*working\s*$/)).toBe(true)
      expect(await ui.findAll({ key: 'pulse-pane' })).toHaveLength(1)
      await ui.unmount()
    }
    w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat({ state: 'waiting', waitingSince: T0, need: 'allow bash', updatedAt: T0 + 5000 }), mtimeMs: T0 + 50 })
    await w.clock.advance(4000)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await hasState(ui, /^\s*allow bash\s*$/)).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^allow bash$/ }))?.props.color).toBe('#6f9fd6')
    expect(await ui.find({ type: 'Text', text: /waiting$/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('the demo', () => {
  test('/pulse demo shows five made-up sessions and clicks stay put', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: 'pulse', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(ran.text ?? '').toMatch(/Five demo sessions/)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(5)
    await ui.press({ key: 'go-demo0000-0000-0000-0000-000000000003' })
    expect(w.runs).toHaveLength(0)
    expect(w.toasts.at(-1) ?? '').toMatch(/Demo row/)
    await ui.press({ key: 'x-demo0000-0000-0000-0000-000000000003' })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
    expect([...w.files.keys()].some(k => k.includes('demo0000'))).toBe(false)
    await ui.unmount()
  })
})

describe('names', () => {
  test('a session name is shown exactly as Claude Code names it', async ($, on) => {
    const w = world(on)
    await start($, w)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^ ?Write newsletter/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /write newsletter/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('titles', () => {
  test('a long title is shown whole while the row has room', async ($, on) => {
    const w = world(on)
    const long = 'Organize every research note from the spring interviews'
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat({ title: long }), mtimeMs: T0 })
    await w.clock.advance(2000)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 160 } })
      expect((await ui.findAll({ type: 'Text', text: /…/ })).length).toBe(0)
      expect(await ui.find({ text: /Organize every research note from the spring interviews/ })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('waiting', () => {
  test('a waiting row shows what it needs instead of a time left', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat({ state: 'waiting', waitingSince: T0 - 30_000, need: 'allow bash' }), mtimeMs: T0 })
    await w.clock.advance(2000)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await hasState(ui, /allow bash/)).toBe(true)
      await ui.unmount()
    }
  })
})

describe('alerts fit', () => {
  test('a long "needs you" phrase is shown whole, on one line', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    w.files.set(`${DIR}/s-${OTHER}.json`, { text: otherBeat({ state: 'waiting', waitingSince: T0 - 30_000, need: 'allow create pull request' }), mtimeMs: T0 })
    await w.clock.advance(2000)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, bodyColumns: 110 } })
      expect(await hasState(ui, /^\s*allow create pull request\s*$/)).toBe(true)
      expect(await ui.find({ type: 'Text', text: /allow create.*…/ })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('a reload', () => {
  test('a session that is already attached keeps publishing', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: null, isInteractive: false })
    expect(w.files.has(`${DIR}/s-${ME}.json`)).toBe(true)
  })
})

describe('this session', () => {
  test('publishes its turn, its plan and its end', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
    const mine = (): Record<string, unknown> => JSON.parse(w.files.get(`${DIR}/s-${ME}.json`)?.text ?? '{}') as Record<string, unknown>
    expect(mine().state).toBe('idle')

    await $.turn.start({ text: 'Fix the login bug', turnId: 't1' })
    expect(mine().state).toBe('working')
    expect(mine().title).toBe('Fix the login bug')

    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Find it', status: 'completed', activeForm: 'Finding it' },
        { content: 'Fix it', status: 'in_progress', activeForm: 'Fixing it' },
        { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
      ],
    })
    await w.clock.advance(1000)
    await w.clock.settle()
    expect(mine().plan).toMatchObject({ done: 1, active: 1, total: 3, source: 'todos' })
    expect(mine().activity).toBe('Fixing it')

    await w.clock.advance(30_000)
    await $.turn.complete({ answer: 'Fixed.', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(mine().state).toBe('done')
    expect(mine().turns).toBe(1)
    // The next turn expects about as long as this one took.
    await $.turn.start({ text: 'And the logout bug', turnId: 't2' })
    expect(mine().expectMs).toBe(30_000)
    expect(mine().title).toBe('Fix the login bug')
    await $.turn.complete({ answer: 'Interrupted.', durationMs: 2_000, isAborted: true, turnId: 't2', reason: 'aborted' })
    expect(mine().state).toBe('stopped')

    await $.session.end({ reason: 'other', sessionId: ME, resume: { id: ME } })
    expect(mine().ended).toBe(true)
  })

  test('a turn whose end was never heard settles once no turn is running', async ($, on) => {
    const w = world(on)
    await start($, w)
    const mine = (): Record<string, unknown> => JSON.parse(w.files.get(`${DIR}/s-${ME}.json`)?.text ?? '{}') as Record<string, unknown>
    await $.turn.start({ text: 'Build the board', turnId: 't1' })
    // Just started: the band may draw before the engine marks the turn running.
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await w.clock.settle()
    await ui.unmount()
    expect(mine().state).toBe('working')
    // Still running: nothing changes however long it takes.
    await w.clock.advance(60_000)
    ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true }, surface: 'terminal' })
    await w.clock.settle()
    await ui.unmount()
    expect(mine().state).toBe('working')
    // No turn running and no turn.complete heard: still working until the quiet spell is long.
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await w.clock.settle()
    await ui.unmount()
    expect(mine().state).toBe('working')
    await w.clock.advance(4 * 60_000)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await w.clock.settle()
    await ui.unmount()
    // ...then the row is done, not stuck at 95%.
    expect(mine().state).toBe('done')
    expect(mine().turns).toBe(1)
  })

  test('a long wait the engine calls idle does not end a turn, and activity revives a settled one', async ($, on) => {
    const w = world(on)
    await start($, w)
    const mine = (): Record<string, unknown> => JSON.parse(w.files.get(`${DIR}/s-${ME}.json`)?.text ?? '{}') as Record<string, unknown>
    const draw = async (): Promise<void> => {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      await w.clock.settle()
      await ui.unmount()
    }
    await $.turn.start({ text: 'Build the board', turnId: 't1' })
    // A tool call every minute keeps the quiet spell from ever filling up.
    for (let i = 0; i < 6; i++) {
      await w.clock.advance(60_000)
      await draw()
      await $.tool.call({ tool: 'Read', input: { file_path: '/x' } })
      await w.clock.advance(2000)
      await w.clock.settle()
      expect(mine().state).toBe('working')
    }
    // Quiet for good: settled. Then the turn shows activity again: working again.
    await draw()
    await w.clock.advance(4 * 60_000)
    await draw()
    expect(mine().state).toBe('done')
    await $.tool.call({ tool: 'Read', input: { file_path: '/y' } })
    await w.clock.advance(20_000)
    await w.clock.settle()
    expect(mine().state).toBe('working')
    expect(mine().turns).toBe(0)
  })
})

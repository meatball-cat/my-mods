// You Should Know (local): /you-should-know asks for a "You should know" summary on demand.
//
// The built-in You should know mod (cc-plugin-you-should-know) checks on its own
// every 6th step of a long turn and can't be called by hand. /you-should-know runs the same
// kind of check right away: a side copy of the model reads this conversation and
// names what the person might miss. The answer shows above the prompt and as a
// dim transcript line; neither is sent to the model. "Ask Claude" puts it in the
// prompt box as a draft, so the person decides whether the main chat sees it.
//
// Each point is a tag (Risk, Verify, To do, Changed, Assumed, Cost), a headline of
// a few words and an optional one-line detail, numbered and sorted most urgent
// first, so the summary can be taken in at a glance.
//
//   /you-should-know            check now
//   /you-should-know <focus>    check with a focus, e.g. /you-should-know tests
//   /you-should-know clear      hide the last summary

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import type { Note, Point, Tag } from '../types'

const noteAtom = atom({ plugin: 'you-should-know', key: 'note' } as const, null)
const checkingAtom = atom({ plugin: 'you-should-know', key: 'isChecking' } as const, false)

// While a check runs, the band shows a spinner and the seconds so far, redrawn
// by a timer. Both live in the module: they only matter while it is drawing.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_MS = 120
let frame = 0
let checkStartedAt = 0
let spinner: { cancel: () => void } | undefined

function startSpinner($: EngineInterface, now: number): void {
  spinner?.cancel()
  frame = 0
  checkStartedAt = now
  spinner = $.clock.every(SPIN_MS, () => {
    frame += 1
    $.ui.invalidate('ui.render')
  })
}

export function spinnerAt(n: number): string {
  return SPINNER[((n % SPINNER.length) + SPINNER.length) % SPINNER.length]
}

export function checkingText(seconds: number): string {
  return ` · checking… ${seconds}s`
}

function stopSpinner(): void {
  spinner?.cancel()
  spinner = undefined
}

const COMMAND_DESCRIPTION = 'You should know: check this chat now for anything you might miss'
const COMMAND_HINT = '[focus | clear]'
const MAX_POINTS = 5
const NOTHING = 'NOTHING'

// Most urgent first; the summary is sorted in this order. 'Note' is for a point
// the model gave without one of the others.
const TAGS: readonly Tag[] = ['Risk', 'Verify', 'To do', 'Changed', 'Assumed', 'Cost', 'Note']
const TAG_COLOR: Record<Tag, ThemeKey> = {
  Risk: 'error',
  Verify: 'warning',
  'To do': 'suggestion',
  Changed: 'claude',
  Assumed: 'permission',
  Cost: 'remember',
  Note: 'subtle',
}
const TAG_WIDTH = Math.max(...TAGS.map(tag => tag.length))
// Band columns for the number and the tag. Bold text on desktop runs close to a
// column per character, so the tag column gets two to spare.
const NUM_CELLS = 3
const TAG_CELLS = TAG_WIDTH + 2
const TAG_MEANING =
  'Risk = could break, lose data or mislead; Verify = looks done but unconfirmed; ' +
  'To do = left unfinished; Changed = touched outside the ask; Assumed = decided without saying; ' +
  'Cost = time, money or tokens'

// The side agent's question. It reads the whole conversation as the main thread
// sent it, so it only needs the ask itself.
export function promptFor(focus: string): string {
  return [
    'Pause the task. You are a second pair of eyes for the person running this session.',
    'From this conversation, list what they should know but could easily miss.',
    focus === '' ? '' : `Focus on: ${focus}.`,
    `Give at most ${MAX_POINTS} points, most important first, one per line, exactly in this form:`,
    '- <Tag> | <headline> | <detail>',
    `Tag is one of: ${TAG_MEANING}.`,
    'Headline: what it is, 8 words at most. Detail: why it matters or what to do, 14 words at most,',
    'or leave it empty. Name the file, test or command when there is one.',
    'Plain words, no preamble, no closing line, and nothing they were already clearly told.',
    `If there is nothing worth flagging, reply with exactly ${NOTHING}.`,
  ]
    .filter(line => line !== '')
    .join(' ')
}

const BULLET = /^([-*•]|\d+[.)])\s+/

function tagOf(word: string): Tag | undefined {
  const key = word.replace(/[[\]*:]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (key === 'todo' || key === 'to-do') return 'To do'
  return TAGS.find(tag => tag.toLowerCase() === key)
}

// "headline — detail" or "headline: detail" when the model put both in one part.
function splitLine(text: string): { headline: string; detail: string } {
  const at = text.search(/\s[—–]\s|:\s/)
  if (at <= 0) return { headline: text, detail: '' }
  const sep = text.slice(at).match(/^(\s[—–]\s|:\s)/)?.[0] ?? ''
  return { headline: text.slice(0, at).trim(), detail: text.slice(at + sep.length).trim() }
}

function pointOf(line: string): Point {
  const body = line.replace(BULLET, '').trim()
  const parts = body.split('|').map(part => part.trim())
  if (parts.length >= 2) {
    const tag = tagOf(parts[0])
    if (tag !== undefined) {
      const rest = parts.slice(1).filter(part => part !== '')
      const split = rest.length === 1 ? splitLine(rest[0]) : { headline: rest[0] ?? '', detail: rest.slice(1).join(' — ') }
      return { tag, ...split }
    }
  }
  // "[Risk] text" or "Risk: text"
  const lead = body.match(/^\[([^\]]+)\]\s*(.+)$/) ?? body.match(/^([A-Za-z -]{2,8}):\s+(.+)$/)
  const tag = lead ? tagOf(lead[1]) : undefined
  if (lead && tag !== undefined) return { tag, ...splitLine(lead[2].trim()) }
  return { tag: 'Note', ...splitLine(body) }
}

// The reply's points, most urgent first: its bullet lines, or every non-empty line
// when it used none.
export function pointsOf(text: string): Point[] {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.replace(/[.\s]+$/, '').toUpperCase() === NOTHING) return []
  const lines = trimmed.split('\n').map(line => line.trim()).filter(line => line !== '')
  const bullets = lines.filter(line => BULLET.test(line))
  return (bullets.length > 0 ? bullets : lines)
    .slice(0, MAX_POINTS)
    .map(pointOf)
    .filter(point => point.headline !== '')
    .map((point, i) => ({ point, i }))
    .sort((a, b) => TAGS.indexOf(a.point.tag) - TAGS.indexOf(b.point.tag) || a.i - b.i)
    .map(({ point }) => point)
}

function lineOf(point: Point): string {
  return point.detail === '' ? point.headline : `${point.headline} — ${point.detail}`
}

export function summaryOf(note: Note): string {
  const title = `You should know${note.focus === '' ? '' : ` · ${note.focus}`}`
  if (note.points.length === 0) return `${title}: nothing worth flagging right now.`
  return [
    `${title} (${note.points.length})`,
    ...note.points.map((point, i) => `${i + 1}. ${point.tag.padEnd(TAG_WIDTH)}  ${lineOf(point)}`),
  ].join('\n')
}

async function check($: EngineInterface, focus: string): Promise<void> {
  try {
    const reply = await $.model.fork({ prompt: promptFor(focus) })
    if (!reply.isAnswered) {
      $.ui.toast(
        reply.reason === 'nothing-to-fork'
          ? 'Nothing to check yet: send a message first, then /you-should-know.'
          : `/you-should-know couldn't finish the check (${reply.reason}).`,
      )
      return
    }
    const note: Note = { points: pointsOf(reply.text), focus, at: await $.clock.now() }
    await update($, noteAtom, () => note)
    $.ui.log(summaryOf(note))
  } catch {
    $.ui.toast("/you-should-know couldn't finish the check.")
  } finally {
    stopSpinner()
    await update($, checkingAtom, () => false)
    $.ui.invalidate('ui.render')
  }
}

async function askClaude($: EngineInterface): Promise<void> {
  const note = await read($, noteAtom)
  if (note === null || note.points.length === 0) return
  const text = [
    'About these points from /you-should-know:',
    ...note.points.map(point => `- ${point.tag}: ${lineOf(point)}`),
    '',
  ].join('\n')
  await $.prompt.fill({ text, mode: 'replace' })
  await update($, noteAtom, () => null)
}

// /you-should-know, or /ysk when another plugin took the name.
async function registerCommand($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: 'you-should-know', description: COMMAND_DESCRIPTION, argumentHint: COMMAND_HINT, immediate: true })
  } catch {
    try {
      await $.command.register({ name: 'ysk', description: COMMAND_DESCRIPTION, argumentHint: COMMAND_HINT, immediate: true })
    } catch {
      return
    }
  }
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await registerCommand($)
    return started
  })

  on('command.run', { command: ['you-should-know', 'ysk'] }, async ($, e) => {
    const args = e.args.trim()
    if (args.toLowerCase() === 'clear') {
      await update($, noteAtom, () => null)
      return { text: 'You should know summary cleared.' }
    }
    if (await read($, checkingAtom)) return { text: 'A /you-should-know check is already running.' }
    await update($, checkingAtom, () => true)
    await update($, noteAtom, () => null)
    startSpinner($, await $.clock.now())
    void check($, args)
    return { text: args === '' ? 'Checking what you should know…' : `Checking what you should know about ${args}…` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const isChecking = await read($, checkingAtom)
    const note = await read($, noteAtom)
    if (!isChecking && note === null) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = Math.max(30, e.props.bodyColumns - 2)
    const lead = NUM_CELLS + TAG_CELLS
    const points = note?.points ?? []
    const focus = note !== null && note.focus !== '' ? ` · ${note.focus}` : ''

    const seconds = isChecking ? Math.max(0, Math.floor(((await $.clock.now()) - checkStartedAt) / 1000)) : 0

    const mine = isChecking ? (
      <Box flexDirection="row">
        <Box width={NUM_CELLS} flexShrink={0}>
          <Text color="claude">{spinnerAt(frame)}</Text>
        </Box>
        <Text bold>You should know</Text>
        <Text dimColor>{checkingText(seconds)}</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Box>
          <Text bold>You should know</Text>
          <Text dimColor>
            {focus} · {points.length === 0 ? 'all clear' : `${points.length} point${points.length === 1 ? '' : 's'}`}
          </Text>
        </Box>
        {points.length === 0 && <Text dimColor>Nothing worth flagging right now.</Text>}
        {points.map((point, i) => {
          const headline = clip(point.headline, columns - lead)
          const room = columns - lead - headline.length - 3
          return (
            // The number and tag sit in fixed-width boxes, not padded text: the
            // desktop app's font is proportional, so spaces don't line up there.
            <Box key={`ysk-point-${i}`} flexDirection="row">
              <Box width={NUM_CELLS} flexShrink={0}>
                <Text dimColor>{`${i + 1}`}</Text>
              </Box>
              <Box width={TAG_CELLS} flexShrink={0}>
                <Text color={TAG_COLOR[point.tag]} bold>
                  {point.tag}
                </Text>
              </Box>
              <Text bold>{headline}</Text>
              {point.detail !== '' && room > 8 && <Text dimColor>{` — ${clip(point.detail, room)}`}</Text>}
            </Box>
          )
        })}
        <Box gap={2}>
          <Button key="ysk-ok" label="Understood" onPress={() => update($, noteAtom, () => null)} />
          {points.length > 0 && <Button key="ysk-ask" label="Ask Claude" onPress={() => askClaude($)} />}
        </Box>
      </Box>
    )

    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })
}

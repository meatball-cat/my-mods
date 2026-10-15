// Jev Router (local): Jev (TypeSafe System One) as a second opinion on routing.
//
// Skill routing: on each prompt the person sends, Jev picks the skill that fits
// best and the pick rides along as a hint the model reads; Claude keeps the final
// say. The Skill line in the transcript shows what Claude actually loaded next to
// Jev's pick, so the two can be compared.
//
// Model routing: when Claude starts a subagent without naming a model, Jev scores
// the task's complexity and the subagent runs on Haiku (1), Sonnet (2-3) or Opus (4).
// The main conversation's model never changes, so its prompt cache stays intact.
//
// Both have an on/off button above the prompt and a command: /jev, /jev-model.
// Everything fails open: if Jev errors, times out or is unsure (< 0.6), nothing
// is added and nothing is changed. The calls go through scripts/jev_skill_router.py.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pick, Complexity } from '../types'

const enabledAtom = atom({ plugin: 'jev-router', key: 'enabled' } as const, true)
const modelRoutingAtom = atom({ plugin: 'jev-router', key: 'modelRouting' } as const, true)
const lastPickAtom = atom({ plugin: 'jev-router', key: 'lastPick' } as const, null)

export const MODEL_FOR: Record<number, 'haiku' | 'sonnet' | 'opus'> = { 1: 'haiku', 2: 'sonnet', 3: 'sonnet', 4: 'opus' }
export const MIN_CONFIDENCE = 0.6
// Only a plain skill name reaches the hint: a project's skills may be untrusted, and a name
// that could carry instructions is dropped (the router filters the same way).
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
// The script's own HTTP timeout is 5 s; this covers Python's start and the keychain read.
const ROUTER_TIMEOUT_MS = 8000
// After a failure (no key, offline, Jev down) skip Jev for a while, so prompts don't wait on it.
const BACKOFF_MS = 120_000
// Prompts the person sent; notifications, peers and schedules are left alone.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

let pausedUntil = 0

// mode is --json or --complexity; the text goes on stdin so it stays out of the process list.
async function router($: EngineInterface, mode: string, text: string): Promise<unknown> {
  const now = await $.clock.now()
  if (now < pausedUntil) return null
  try {
    const script = $.plugin.root + '/scripts/jev_skill_router.py'
    const r = await $.process.run(['python3', script, mode, '-'], { stdin: text, timeoutMs: ROUTER_TIMEOUT_MS })
    if (r.exitCode === 0 && r.stdout.trim()) return JSON.parse(r.stdout)
  } catch {}
  pausedUntil = now + BACKOFF_MS
  return null
}

export function asPick(v: unknown): Pick | null {
  const o = v as Pick | null
  return o && typeof o.choice === 'string' && typeof o.confidence === 'number' ? { choice: o.choice, confidence: o.confidence } : null
}

export function asComplexity(v: unknown): Complexity | null {
  const o = v as Complexity | null
  return o && typeof o.score === 'number' && typeof o.confidence === 'number' ? { score: o.score, confidence: o.confidence } : null
}

/** The hint the model reads beside the prompt, or null when Jev has nothing confident to say. */
export function hintFor(pick: Pick | null): string | null {
  if (!pick || pick.choice === 'none' || pick.confidence < MIN_CONFIDENCE || !SKILL_NAME.test(pick.choice)) return null
  return `Jev picked the ${pick.choice} skill (confidence ${pick.confidence.toFixed(2)}).`
}

/** The model a subagent should run on, or null to leave it as Claude asked. */
export function modelFor(c: Complexity | null): 'haiku' | 'sonnet' | 'opus' | null {
  if (!c || c.confidence < MIN_CONFIDENCE) return null
  return MODEL_FOR[c.score] ?? null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'jev', description: 'Toggle Jev skill routing', immediate: true })
    await $.command.register({ name: 'jev-model', description: 'Toggle Jev subagent model routing', immediate: true })
    const a = await $.store.get('enabled')
    if (typeof a === 'boolean') await update($, enabledAtom, () => a)
    const b = await $.store.get('modelRouting')
    if (typeof b === 'boolean') await update($, modelRoutingAtom, () => b)
    return next(e)
  })

  on('command.run', { command: 'jev' }, async $ => {
    const isOn = await update($, enabledAtom, v => !v)
    await $.store.set('enabled', isOn)
    return { text: `Jev skill routing ${isOn ? 'on' : 'off'}` }
  })

  on('command.run', { command: 'jev-model' }, async $ => {
    const isOn = await update($, modelRoutingAtom, v => !v)
    await $.store.set('modelRouting', isOn)
    return { text: `Jev model routing ${isOn ? 'on' : 'off'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (e.props.hasSurvey) return theirs
    const enabled = await read($, enabledAtom)
    const modelRouting = await read($, modelRoutingAtom)
    const { Box, Button } = $.ui.resolve(e)
    const toggleSkills = async () => $.store.set('enabled', await update($, enabledAtom, v => !v))
    const toggleModels = async () => $.store.set('modelRouting', await update($, modelRoutingAtom, v => !v))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Button key="jev" plain label={enabled ? 'Jev ● on' : 'Jev ○ off'} onPress={toggleSkills} />
          <Button key="jev-model" plain label={modelRouting ? 'Model ● on' : 'Model ○ off'} onPress={toggleModels} />
        </Box>
        {theirs}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON.has(e.origin.kind) || !(await read($, enabledAtom))) {
      await update($, lastPickAtom, () => null)
      return next(e)
    }
    const pick = asPick(await router($, '--json', e.text))
    await update($, lastPickAtom, () => pick)
    const hint = hintFor(pick)
    if (!hint || !pick) return next(e)
    $.ui.log(`Jev → ${pick.choice} (${pick.confidence.toFixed(2)})`)
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.tool === 'Skill' && (await read($, enabledAtom))) {
      const pick = await read($, lastPickAtom)
      $.ui.log(`Skill used: ${e.skill} · Jev: ${pick ? `${pick.choice} (${pick.confidence.toFixed(2)})` : 'no pick'}`)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool !== 'Agent' || e.model || !(await read($, modelRoutingAtom))) return next(e)
    // A fork keeps the parent's model; a plugin's agent type names its own tier.
    const type = e.subagent_type ?? ''
    if (type === 'fork' || type.includes(':')) return next(e)
    const model = modelFor(asComplexity(await router($, '--complexity', e.prompt)))
    if (!model) return next(e)
    $.ui.log(`Jev: subagent "${e.description || 'task'}" → ${model}`)
    return next({ ...e, model })
  })
}

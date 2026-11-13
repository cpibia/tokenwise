import type { EngineInterface, Register } from 'claude-code'

import { type AssessmentInput, type Language, buildPrompt, buildSystem, parseAssessment } from './assessor'
import { COPY, type Copy } from './copy'
import { journalPath, record } from './journal'
import {
  type Assessment,
  type Plan,
  type SessionView,
  CHEAP_SWITCH_MAX_CONTEXT,
  currentLevel,
  freshStartReason,
  isConfirmation,
  plan,
} from './policy'
import {
  TIERS,
  type Effort,
  type Level,
  type TierId,
  asEffort,
  ceilingEffort,
  clampTier,
  displayName,
  effortOn,
  sameFamily,
} from './tiers'

const GENERIC_SUBAGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude'])
// Above this tier a subagent's level is a decision for a person, not for the mod.
const SUBAGENT_TIER_CAP: TierId = 6
const SKIP_PREFIX = '~'
const MECHANICAL_TIER = 3
const RESTART_DELAY_MS = 100
const CLASSIFIER_TIMEOUT_MS = 20_000
const CLASSIFIER_MAX_TOKENS = 300
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const FRESH_START_THRESHOLDS: Record<string, number> = { off: 0, '80k': 80_000, '120k': 120_000, '160k': 160_000 }

type Settings = {
  language: 'auto' | Language
  classifierModel: string
  profile: string
  freshStartTokens: number
}

type SessionState = {
  enabled: boolean
  active: Level | null
  // The session's own level when the mod took over: a change from it means /model or /effort.
  base: { model: string; effort: Effort | null } | null
  settled: boolean
  recentTiers: TierId[]
  lastRunTier: TierId | null
  keptModel: string | null
  homeModel: string | null
  sessionEffort: Effort | null
  lastActivityAt: number | null
  resubmit: string | null
}

function newSessionState(enabled = true): SessionState {
  return {
    enabled,
    active: null,
    base: null,
    settled: false,
    recentTiers: [],
    lastRunTier: null,
    keptModel: null,
    homeModel: null,
    sessionEffort: null,
    lastActivityAt: null,
    resubmit: null,
  }
}

let settings: Settings = { language: 'auto', classifierModel: 'sonnet', profile: '', freshStartTokens: 120_000 }
let resolvedLanguage: Language | null = null
let session = newSessionState()
const subagentEfforts = new Map<string, Effort>()

export function readSettings(options: Record<string, unknown>): Settings {
  const language = options.language === 'en' || options.language === 'it' ? options.language : 'auto'
  const classifier = options.classifierModel === 'haiku' ? 'haiku' : 'sonnet'
  const threshold = FRESH_START_THRESHOLDS[String(options.freshStart ?? '120k')] ?? 120_000

  return {
    language,
    classifierModel: classifier,
    profile: String(options.profile ?? '').trim().slice(0, 1000),
    freshStartTokens: threshold,
  }
}

async function language($: EngineInterface): Promise<Language> {
  if (settings.language !== 'auto') {
    return settings.language
  }
  if (resolvedLanguage === null) {
    try {
      const row = (await $.config.list()).find(r => r.key === 'language')
      resolvedLanguage = /^(it|ital)/i.test(String(row?.value ?? '').trim()) ? 'it' : 'en'
    } catch {
      return 'en'
    }
  }

  return resolvedLanguage
}

async function copy($: EngineInterface): Promise<Copy> {
  return COPY[await language($)]
}

async function isWatched($: EngineInterface): Promise<boolean> {
  return session.enabled && (await $.session.surfaces()).length > 0
}

async function assess($: EngineInterface, input: AssessmentInput): Promise<Assessment | null> {
  const lang = await language($)
  try {
    const result = await $.model.complete({
      model: settings.classifierModel,
      system: buildSystem(lang, input.kind, settings.profile),
      prompt: buildPrompt(lang, input),
      effort: 'low',
      maxTokens: CLASSIFIER_MAX_TOKENS,
      timeoutMs: CLASSIFIER_TIMEOUT_MS,
    })
    if (!result.isAnswered) {
      $.ui.log(`no assessment (${result.reason})`, { to: 'debug' })

      return null
    }

    return parseAssessment(result.text)
  } catch (error) {
    $.ui.log(`assessment failed (${String(error)})`, { to: 'debug' })

    return null
  }
}

/** The end of the last reply and any question put through a dialog since the person last wrote. */
async function conversationTail($: EngineInterface): Promise<{ reply: string; question: string }> {
  try {
    const messages = await $.session.messages()
    let question = ''
    for (let i = messages.length - 1; i >= 0 && !question; i--) {
      const message = messages[i]
      if (!message || (message.role === 'user' && message.text.trim())) {
        break
      }
      for (const use of [...message.toolUses].reverse()) {
        const asked = Array.isArray(use.input.questions)
          ? (use.input.questions as { question?: unknown }[]).map(q => (typeof q?.question === 'string' ? q.question : '')).join(' ')
          : ''
        if (asked.trim()) {
          question = asked.replace(/\s+/g, ' ').trim()
          break
        }
      }
    }
    const reply = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text.trim() ?? ''

    return { reply, question }
  } catch {
    return { reply: '', question: '' }
  }
}

function view(sessionModel: string, contextTokens = 0): SessionView {
  return {
    sessionModel,
    sessionEffort: session.sessionEffort,
    contextTokens,
    active: session.active,
    settled: session.settled,
    recentTiers: session.recentTiers,
    lastRunTier: session.lastRunTier,
    keptModel: session.keptModel,
    homeModel: session.homeModel,
  }
}

async function activate($: EngineInterface, level: Level, sessionModel: string): Promise<void> {
  const previousModel = session.active?.model ?? sessionModel
  const matchesSession = sameFamily(level.model, sessionModel) && level.effort === session.sessionEffort
  session.active = matchesSession ? null : level
  session.base = matchesSession ? null : { model: sessionModel, effort: session.sessionEffort }
  $.ui.status(session.active ? (await copy($)).status(displayName(level.model, level.effort)) : undefined)
  if (!sameFamily(previousModel, level.model)) {
    $.ui.invalidate('prompt.section')
  }
}

async function deactivate($: EngineInterface): Promise<void> {
  const hadModel = session.active !== null && session.base !== null && !sameFamily(session.active.model, session.base.model)
  session.active = null
  session.base = null
  $.ui.status(undefined)
  if (hadModel) {
    $.ui.invalidate('prompt.section')
  }
}

/** The first working request sets the model later work returns to after a light request. */
function settleHome(tier: TierId, level: Level): void {
  if (!session.settled && tier > 2) {
    session.homeModel = level.model
  }
}

async function carryOut($: EngineInterface, decision: Plan, assessment: Assessment, sessionModel: string): Promise<string> {
  const text = await copy($)
  const current = currentLevel(view(sessionModel))
  const currentName = displayName(current.model, current.effort)

  if (decision.kind === 'stay') {
    return `stays on ${currentName}: ${decision.note}`
  }
  if (decision.kind === 'apply') {
    settleHome(decision.tier, decision.level)
    await activate($, decision.level, sessionModel)

    return `auto: ${currentName} → ${displayName(decision.level.model, decision.level.effort)}`
  }

  const recommendedName = displayName(decision.recommended.model, decision.recommended.effort)
  const fallbackName = displayName(decision.fallback.model, decision.fallback.effort)
  let question = text.recommend(recommendedName, assessment.reason)
  if (decision.switchesModel) {
    const tokens = (await $.session.usage()).context.tokens ?? 0
    const cost = tokens < CHEAP_SWITCH_MAX_CONTEXT ? text.cheapSwitch : text.costlySwitch(Math.round(tokens / 1000))
    question = text.needsStronger(recommendedName, assessment.reason, cost)
  }
  if (decision.wider) {
    question = `${question} ${text.widerHint}`
  }

  const pick = text.pick(recommendedName)
  const wider = decision.wider ? text.wholeSession(displayName(decision.wider.model, decision.wider.effort)) : null
  const keep = decision.switchesModel ? text.sameModel(fallbackName) : text.keep(fallbackName)
  const options = [pick, ...(wider ? [wider] : []), keep, text.mute]

  let answer: string
  try {
    answer = await $.ui.ask(question, { options, header: text.header })
  } catch {
    return `question for ${recommendedName} dismissed: stays on ${currentName}`
  }

  if (answer === text.mute) {
    session.enabled = false
    $.ui.toast(text.muted)

    return 'turned off by the person'
  }
  const chosen = answer === pick ? decision.recommended : answer === wider ? decision.wider : decision.fallback
  if (!chosen) {
    return `unrecognised answer: stays on ${currentName}`
  }
  if (chosen === decision.fallback) {
    session.keptModel = current.model
  }
  settleHome(decision.tier, chosen)
  await activate($, chosen, sessionModel)

  return `asked for ${recommendedName}: chose ${displayName(chosen.model, chosen.effort)}`
}

type FreshChoice = 'clear' | 'compact' | 'carry-on' | 'mute'

async function offerFreshStart($: EngineInterface, reason: 'new-topic' | 'idle', tokens: number): Promise<FreshChoice> {
  const text = await copy($)
  const options = reason === 'new-topic' ? [text.clearAndGo, text.compactAndGo, text.carryOn, text.mute] : [text.compactAndGo, text.clearAndGo, text.carryOn, text.mute]
  try {
    const answer = await $.ui.ask(text.fresh(reason, Math.round(tokens / 1000)), { options, header: text.freshHeader })
    if (answer === text.clearAndGo) return 'clear'
    if (answer === text.compactAndGo) return 'compact'
    if (answer === text.mute) return 'mute'
  } catch {
    // A dismissed question means carrying on.
  }

  return 'carry-on'
}

/**
 * Clears or compacts once the dropped prompt has left the hook, then sends the request again.
 * A command cannot run from inside the hook the prompt waits on, hence the timer.
 */
function restart($: EngineInterface, mode: 'clear' | 'compact', request: string): void {
  session.resubmit = request
  $.clock.after(RESTART_DELAY_MS, () => {
    void (async () => {
      try {
        if (mode === 'clear') {
          await $.command.run({ command: 'clear', args: '' })
        } else {
          await $.session.compact()
        }
        await $.prompt.submit({ text: request, asUser: true })
      } catch (error) {
        session.resubmit = null
        $.ui.log(`${mode} failed (${String(error)})`, { to: 'debug' })
        if (mode === 'clear') {
          await $.prompt.fill({ text: '/clear' })
          $.ui.toast((await copy($)).clearFallback, { timeoutMs: 10_000 })
        } else {
          await $.prompt.fill({ text: request })
        }
      }
    })()
  })
}

function remember(tier: TierId): void {
  session.recentTiers = [...session.recentTiers, tier].slice(-3)
  session.lastRunTier = tier
  if (tier > 2) {
    session.settled = true
  }
}

export const register: Register = (on, options) => {
  settings = readSettings(options as Record<string, unknown>)
  resolvedLanguage = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokenwise', description: (await copy($)).command, argumentHint: 'on | off | reset | status' })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const { enabled, resubmit } = session
      session = { ...newSessionState(enabled), resubmit }
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'tokenwise' }, async ($, e) => {
    const text = await copy($)
    const argument = e.args.trim().toLowerCase()
    if (argument === 'off') {
      session.enabled = false
      await deactivate($)

      return { text: text.off }
    }
    if (argument === 'on') {
      session.enabled = true

      return { text: text.on }
    }
    if (argument === 'reset') {
      await deactivate($)
      session.keptModel = null
      session.homeModel = null
      await record($, { kind: 'override', outcome: 'reset by command' })

      return { text: text.reset }
    }
    const level = session.active ? displayName(session.active.model, session.active.effort) : null

    return { text: text.state(session.enabled, level, await journalPath($, await $.clock.now())) }
  })

  on('prompt.submit', async ($, e, next) => {
    const isOwnResubmit = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    const isPerson = PERSON_ORIGINS.has(e.origin.kind) || isOwnResubmit
    if (e.command || e.isMeta || e.turnId || !isPerson || !(await isWatched($))) {
      return next(e)
    }

    const request = e.text.trim()
    if (request.startsWith(SKIP_PREFIX)) {
      session.settled = true
      await record($, { kind: 'request', text: request, outcome: 'skipped with ~' })

      return next({ ...e, text: request.slice(SKIP_PREFIX.length).trimStart() })
    }

    const now = await $.clock.now()
    const idleMs = session.lastActivityAt === null ? 0 : now - session.lastActivityAt
    session.lastActivityAt = now
    const isResubmit = isOwnResubmit && session.resubmit === e.text
    if (isResubmit) {
      session.resubmit = null
    }

    const previousTier = session.recentTiers.at(-1) ?? null
    if (!isResubmit && isConfirmation(request) && previousTier !== null && previousTier > MECHANICAL_TIER) {
      await record($, { kind: 'request', text: request, tier: previousTier, outcome: 'confirmation: level kept' })

      return next(e)
    }

    const tail = await conversationTail($)
    const assessment = await assess($, {
      kind: 'request',
      request,
      previousReply: tail.reply,
      pendingQuestion: tail.question,
      previousTier,
      profile: settings.profile,
    })
    if (!assessment) {
      await record($, { kind: 'request', text: request, outcome: 'no assessment: level kept' })

      return next(e)
    }

    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (!isResubmit) {
      const reason = freshStartReason({ contextTokens: tokens, threshold: settings.freshStartTokens, newTopic: assessment.newTopic, idleMs })
      if (reason) {
        const choice = await offerFreshStart($, reason, tokens)
        await record($, { kind: 'fresh-start', text: request, tier: assessment.tier, reason, outcome: choice, contextTokens: tokens })
        if (choice === 'mute') {
          session.enabled = false
          $.ui.toast((await copy($)).muted)

          return next(e)
        }
        if (choice === 'clear' || choice === 'compact') {
          restart($, choice, e.text)

          return { drop: `tokenwise: ${choice} then resend` }
        }
      }
    }

    const sessionModel = await $.session.model()
    const modelBefore = session.active?.model ?? sessionModel
    const decision = plan(view(sessionModel, tokens), assessment)
    const outcome = await carryOut($, decision, assessment, sessionModel)
    remember(decision.tier)
    await record($, {
      kind: 'request',
      text: request,
      tier: decision.tier,
      reason: assessment.reason,
      outcome,
      ...(assessment.rework ? { rework: true } : {}),
    })

    const modelAfter = session.active?.model ?? sessionModel
    if (!sameFamily(modelBefore, modelAfter) && session.active) {
      const note = (await copy($)).modelNote(displayName(session.active.model), session.active.model)

      return next({ ...e, context: [...(e.context ?? []), note] })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    session.lastActivityAt = await $.clock.now()

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const effort = subagentEfforts.get(e.agentId)

      return yield* next(effort ? { ...e, effort } : e)
    }

    const seen = asEffort(e.effort)
    if (!session.active || !session.base) {
      session.sessionEffort = seen

      return yield* next(e)
    }
    if (session.base.effort === null) {
      session.base = { ...session.base, effort: seen }
    }
    if (!sameFamily(session.base.model, e.model) || session.base.effort !== seen) {
      // The person changed model or effort with /model or /effort: their choice wins.
      await record($, {
        kind: 'override',
        outcome: `session set to ${displayName(e.model, seen)} over ${displayName(session.active.model, session.active.effort)}`,
      })
      session.sessionEffort = seen
      session.homeModel = null
      await deactivate($)

      return yield* next(e)
    }

    return yield* next({ ...e, model: session.active.model, effort: session.active.effort })
  }).catch(async function* (_, e, next) {
    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const isGeneric = !e.fork && !e.resume && !e.workflow && !e.isTeammate && GENERIC_SUBAGENTS.has(e.subagentType)
    if (!isGeneric || !(await isWatched($))) {
      return next(e)
    }
    const assessment = await assess($, {
      kind: 'subagent',
      request: `${e.description}\n\n${e.prompt}`,
      previousReply: '',
      pendingQuestion: '',
      previousTier: null,
      profile: settings.profile,
    })
    if (!assessment) {
      return next(e)
    }

    const tier = clampTier(Math.min(assessment.tier, SUBAGENT_TIER_CAP))
    const model = e.model ?? TIERS[tier].model
    const effort = e.model ? (effortOn(e.model, tier) ?? ceilingEffort(e.model)) : TIERS[tier].effort
    const started = await next(e.model ? e : { ...e, model })
    if (!started.deny && started.agentId) {
      subagentEfforts.set(started.agentId, effort)
      const text = await copy($)
      $.ui.log(text.subagent(e.description, displayName(model, effort), assessment.reason))
      await record($, {
        kind: 'subagent',
        text: e.description,
        tier,
        reason: assessment.reason,
        outcome: `${displayName(model, effort)}${e.model ? ', model chosen by the session' : ''}`,
      })
    }

    return started
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('prompt.section', { name: 'env_info_model' }, async ($, e, next) => {
    const result = await next(e)
    const { active, base } = session
    if (!result.text || !active || !base || sameFamily(active.model, base.model)) {
      return result
    }

    return { ...result, text: swapModelName(result.text, base.model, active.model) }
  }).catch(($, e, next) => next(e))

  on('attribution.text', async ($, e, next) => {
    const result = await next(e)
    const { active, base } = session
    if (!active || !base || sameFamily(active.model, base.model)) {
      return result
    }

    return { ...result, text: swapModelName(result.text, base.model, active.model) }
  }).catch(($, e, next) => next(e))
}

function swapModelName(text: string, from: string, to: string): string {
  return text.split(displayName(from)).join(displayName(to)).split(from).join(to)
}

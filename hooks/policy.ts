import {
  TIERS,
  type Effort,
  type Level,
  type TierId,
  ceilingEffort,
  clampTier,
  compareEffort,
  effortOn,
  familyOf,
  isStrongerFamily,
  sameFamily,
} from './tiers'

export type Assessment = {
  tier: TierId
  reason: string
  newTopic: boolean
  rework: boolean
}

export type SessionView = {
  sessionModel: string
  sessionEffort: Effort | null
  contextTokens: number
  active: Level | null
  settled: boolean
  recentTiers: readonly TierId[]
  lastRunTier: TierId | null
  keptModel: string | null
  // The model the first working request settled on, when it differs from the session's own.
  homeModel: string | null
}

export type Plan =
  | { kind: 'stay'; tier: TierId; note: string }
  | { kind: 'apply'; tier: TierId; level: Level; note: string }
  | { kind: 'ask'; tier: TierId; recommended: Level; fallback: Level; wider: Level | null; switchesModel: boolean }

// Up to this tier a request is a question or a single command: it runs on Haiku when that
// pays off, and it does not settle the session, so the next working request is sized from the
// model the person started with.
const LIGHT_TIER = 2

// Haiku 5.5 bills prompts above 100K tokens at five times the base rate. Below it, writing the
// context to Haiku's cache costs about what a cache read on Opus does, and output is 40 times
// cheaper; the stronger model's cache stays warm for the way back.
const LIGHT_MODEL_MAX_CONTEXT = 100_000
const LIGHT_MODEL = TIERS[1].model

// Below this context, re-reading the conversation on another model without the cache costs
// less than staying on a stronger model than the work needs.
export const CHEAP_SWITCH_MAX_CONTEXT = 40_000

/**
 * The tier the work needs. When the person says the last result was wrong, the redo runs at
 * least one tier above the one that produced it: repeating the same level rarely fixes it.
 */
export function targetTier(assessment: Assessment, view: Pick<SessionView, 'lastRunTier'>): TierId {
  if (assessment.rework && view.lastRunTier !== null) {
    return clampTier(Math.max(assessment.tier, view.lastRunTier + 1))
  }

  return assessment.tier
}

export function currentLevel(view: SessionView): { model: string; effort: Effort | null } {
  return view.active ?? { model: view.sessionModel, effort: view.sessionEffort }
}

function isSameLevel(a: { model: string; effort: Effort | null }, b: Level): boolean {
  return sameFamily(a.model, b.model) && a.effort === b.effort
}

function isLighter(level: Level, current: { model: string; effort: Effort | null }): boolean {
  if (!sameFamily(level.model, current.model)) {
    return isStrongerFamily(current.model, level.model)
  }

  return current.effort !== null && compareEffort(level.effort, current.effort) < 0
}

export function plan(view: SessionView, assessment: Assessment): Plan {
  const tier = targetTier(assessment, view)
  const current = currentLevel(view)

  if (!view.settled && tier > LIGHT_TIER) {
    return planOpening(view, current, tier)
  }

  if (tier <= LIGHT_TIER && !assessment.rework && view.contextTokens <= LIGHT_MODEL_MAX_CONTEXT) {
    const effort = effortOn(LIGHT_MODEL, tier)
    if (effort !== null) {
      return planMove(view, current, tier, { model: LIGHT_MODEL, effort })
    }
  }

  const recommended = TIERS[tier]
  if (!assessment.rework && view.contextTokens < CHEAP_SWITCH_MAX_CONTEXT && isStrongerFamily(current.model, recommended.model)) {
    return planMove(view, current, tier, recommended)
  }

  // After a light request on Haiku, work comes back to the session's working model without asking.
  const home = view.homeModel ?? view.sessionModel
  const model = isStrongerFamily(home, current.model) ? home : current.model
  const effort = effortOn(model, tier)
  if (effort !== null) {
    return planMove(view, current, tier, { model, effort })
  }

  const fallback: Level = { model, effort: ceilingEffort(model) }
  if (view.keptModel !== null && sameFamily(view.keptModel, model) && !assessment.rework) {
    return isSameLevel(current, fallback)
      ? { kind: 'stay', tier, note: 'kept model, already at its ceiling' }
      : { kind: 'apply', tier, level: fallback, note: 'kept model, effort raised to its ceiling' }
  }

  return { kind: 'ask', tier, recommended: TIERS[tier], fallback, wider: null, switchesModel: true }
}

function planOpening(view: SessionView, current: { model: string; effort: Effort | null }, tier: TierId): Plan {
  const home = view.sessionModel
  const recommended = TIERS[tier]
  if (sameFamily(home, recommended.model)) {
    const level = { model: home, effort: effortOn(home, tier) ?? recommended.effort }

    return isSameLevel(current, level)
      ? { kind: 'stay', tier, note: 'session model already fits' }
      : { kind: 'apply', tier, level, note: 'effort set for the session' }
  }
  // With an almost empty context, moving down to the tier's model costs nothing to cache.
  if (isStrongerFamily(home, recommended.model)) {
    return isSameLevel(current, recommended)
      ? { kind: 'stay', tier, note: 'tier level already in use' }
      : { kind: 'apply', tier, level: recommended, note: 'tier level for the session' }
  }

  // The first working request is often a preparatory step: offering Opus now avoids a costly
  // switch later, when the conversation has grown.
  const opus = TIERS[5].model
  const wider =
    familyOf(recommended.model) === 'sonnet' ? { model: opus, effort: effortOn(opus, tier) ?? 'medium' } : null
  const fallback = { model: home, effort: effortOn(home, tier) ?? ceilingEffort(home) }

  return { kind: 'ask', tier, recommended, fallback, wider, switchesModel: false }
}

function planMove(view: SessionView, current: { model: string; effort: Effort | null }, tier: TierId, level: Level): Plan {
  if (isSameLevel(current, level)) {
    return { kind: 'stay', tier, note: 'already at the right level' }
  }

  // The level goes up at once but comes down only after two lighter requests in a row, so a
  // quick question in the middle of heavy work does not deflate the next step.
  const previous = view.recentTiers.at(-1)
  const isLowering = isLighter(level, current)
  if (isLowering && previous !== undefined && previous > tier) {
    return { kind: 'stay', tier, note: 'waiting for a second light request before lowering the level' }
  }
  if (!sameFamily(level.model, current.model)) {
    return { kind: 'apply', tier, level, note: isLowering ? 'lighter model for a light request' : 'back to a stronger model' }
  }

  return { kind: 'apply', tier, level, note: isLowering ? 'effort lowered' : 'effort raised' }
}

export type FreshStartReason = 'new-topic' | 'idle'

export const IDLE_MS = 60 * 60 * 1000

/**
 * Whether to offer a fresh start before this request. Re-reading a long conversation is
 * where most tokens go, so a new topic over a large context is the moment to drop it; after
 * an hour away the prompt cache has expired anyway and the whole context is paid again.
 */
export function freshStartReason(input: {
  contextTokens: number
  threshold: number
  newTopic: boolean
  idleMs: number
}): FreshStartReason | null {
  if (input.threshold <= 0 || input.contextTokens < input.threshold) {
    return null
  }
  if (input.newTopic) {
    return 'new-topic'
  }

  return input.idleMs >= IDLE_MS ? 'idle' : null
}

const CONFIRMATION_WORDS = new Set([
  'ok', 'okay', 'okk', 'oki', 'yes', 'yep', 'yeah', 'sure', 'go', 'ahead', 'do', 'it', 'proceed', 'continue',
  'please', 'thanks', 'fine', 'great', 'perfect', 'si', 'sì', 'vai', 'pure', 'procedi', 'procediamo', 'prosegui',
  'continua', 'avanti', 'fai', 'fallo', 'perfetto', 'ottimo', 'confermo', "d'accordo", 'esatto', 'grazie', 'dai',
])
const CONFIRMATION_MAX_WORDS = 5

/** A bare go-ahead continues the work just proposed, at the level it was assessed. */
export function isConfirmation(text: string): boolean {
  if (text.includes('?')) {
    return false
  }
  const words = text.toLowerCase().replace(/[.,;:!]/g, ' ').split(/\s+/).filter(Boolean)

  return words.length > 0 && words.length <= CONFIRMATION_MAX_WORDS && words.every(word => CONFIRMATION_WORDS.has(word))
}

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
  active: Level | null
  settled: boolean
  recentTiers: readonly TierId[]
  lastRunTier: TierId | null
  keptModel: string | null
}

export type Plan =
  | { kind: 'stay'; tier: TierId; note: string }
  | { kind: 'apply'; tier: TierId; level: Level; note: string }
  | { kind: 'ask'; tier: TierId; recommended: Level; fallback: Level; wider: Level | null; switchesModel: boolean }

// Below this tier a request is a question or a single command: it does not tell yet which
// model the session's work needs, so it never settles the session on Haiku.
const LIGHT_TIER = 2

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

export function plan(view: SessionView, assessment: Assessment): Plan {
  const tier = targetTier(assessment, view)
  const current = currentLevel(view)

  if (!view.settled && tier > LIGHT_TIER) {
    return planOpening(current, tier)
  }

  const effort = effortOn(current.model, tier)
  if (effort !== null) {
    return planOnSameModel(view, current, tier, effort)
  }

  const fallback: Level = { model: current.model, effort: ceilingEffort(current.model) }
  if (view.keptModel !== null && sameFamily(view.keptModel, current.model) && !assessment.rework) {
    return isSameLevel(current, fallback)
      ? { kind: 'stay', tier, note: 'kept model, already at its ceiling' }
      : { kind: 'apply', tier, level: fallback, note: 'kept model, effort raised to its ceiling' }
  }

  return { kind: 'ask', tier, recommended: TIERS[tier], fallback, wider: null, switchesModel: true }
}

function planOpening(current: { model: string; effort: Effort | null }, tier: TierId): Plan {
  const recommended = TIERS[tier]
  if (sameFamily(current.model, recommended.model) || isStrongerFamily(current.model, recommended.model)) {
    const effort = effortOn(current.model, tier) ?? recommended.effort
    const level = { model: current.model, effort }

    return isSameLevel(current, level)
      ? { kind: 'stay', tier, note: 'session model already fits' }
      : { kind: 'apply', tier, level, note: 'effort set for the session' }
  }

  // The first working request is often a preparatory step: offering Opus now avoids a costly
  // switch later, when the conversation has grown.
  const opus = TIERS[5].model
  const wider =
    familyOf(recommended.model) === 'sonnet' ? { model: opus, effort: effortOn(opus, tier) ?? 'medium' } : null
  const fallback = { model: current.model, effort: effortOn(current.model, tier) ?? ceilingEffort(current.model) }

  return { kind: 'ask', tier, recommended, fallback, wider, switchesModel: false }
}

function planOnSameModel(
  view: SessionView,
  current: { model: string; effort: Effort | null },
  tier: TierId,
  effort: Effort,
): Plan {
  const level = { model: current.model, effort }
  if (isSameLevel(current, level)) {
    return { kind: 'stay', tier, note: 'already at the right level' }
  }

  // Effort goes up at once but comes down only after two lighter requests in a row, so a
  // quick question in the middle of heavy work does not deflate the next step.
  const previous = view.recentTiers.at(-1)
  const isLowering = current.effort !== null && compareEffort(effort, current.effort) < 0
  if (isLowering && previous !== undefined && previous > tier) {
    return { kind: 'stay', tier, note: 'waiting for a second light request before lowering effort' }
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

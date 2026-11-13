import { describe, expect, test } from 'claude-code/testing'

import { parseAssessment } from './assessor'
import { type Assessment, type SessionView, freshStartReason, isConfirmation, plan, targetTier } from './policy'
import { displayName, effortOn } from './tiers'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

function sessionOn(model: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionModel: model,
    sessionEffort: 'medium',
    contextTokens: 30_000,
    active: null,
    settled: true,
    recentTiers: [],
    lastRunTier: null,
    keptModel: null,
    homeModel: null,
    ...overrides,
  }
}

function assessed(tier: Assessment['tier'], extra: Partial<Assessment> = {}): Assessment {
  return { tier, reason: '', newTopic: false, rework: false, ...extra }
}

describe('targetTier', () => {
  test('a redo runs one tier above the work it corrects', () => {
    expect(targetTier(assessed(5, { rework: true }), { lastRunTier: 7 })).toBe(8)
  })

  test('a redo never goes below the assessed tier', () => {
    expect(targetTier(assessed(7, { rework: true }), { lastRunTier: 3 })).toBe(7)
  })

  test('the top tier is a ceiling', () => {
    expect(targetTier(assessed(8, { rework: true }), { lastRunTier: 8 })).toBe(8)
  })
})

describe('plan', () => {
  test('effort rises on the same model without asking', () => {
    const decision = plan(sessionOn(OPUS), assessed(6))
    expect(decision).toEqual({ kind: 'apply', tier: 6, level: { model: OPUS, effort: 'high' }, note: 'effort raised' })
  })

  test('effort waits for a second light request before coming down', () => {
    const view = sessionOn(OPUS, { sessionEffort: 'high', recentTiers: [6] })
    expect(plan(view, assessed(4)).kind).toBe('stay')
    expect(plan({ ...view, recentTiers: [6, 4] }, assessed(4)).kind).toBe('apply')
  })

  test('work beyond the model in use asks before switching', () => {
    const decision = plan(sessionOn(SONNET, { sessionEffort: 'high' }), assessed(6))
    expect(decision.kind).toBe('ask')
    if (decision.kind === 'ask') {
      expect(decision.switchesModel).toBe(true)
      expect(decision.recommended).toEqual({ model: OPUS, effort: 'high' })
      expect(decision.fallback).toEqual({ model: SONNET, effort: 'high' })
    }
  })

  test('a kept model is not questioned again, except to redo failed work', () => {
    const view = sessionOn(SONNET, { sessionEffort: 'high', keptModel: SONNET })
    expect(plan(view, assessed(6)).kind).toBe('stay')
    expect(plan({ ...view, lastRunTier: 4 }, assessed(6, { rework: true })).kind).toBe('ask')
  })

  test('failed Opus xhigh work reaches Fable', () => {
    const view = sessionOn(OPUS, { sessionEffort: 'xhigh', lastRunTier: 7 })
    const decision = plan(view, assessed(7, { rework: true }))
    expect(decision.kind === 'ask' && decision.recommended.model).toBe('claude-fable-5-2')
  })

  test('a light opening runs on Haiku without settling the session there', () => {
    const view = sessionOn(OPUS, { settled: false })
    expect(plan(view, assessed(2))).toEqual({
      kind: 'apply',
      tier: 2,
      level: { model: HAIKU, effort: 'medium' },
      note: 'lighter model for a light request',
    })
    const next = plan({ ...view, active: { model: HAIKU, effort: 'medium' }, recentTiers: [2] }, assessed(5))
    expect(next.kind === 'apply' && next.level).toEqual({ model: OPUS, effort: 'medium' })
  })

  test('work after a light request goes back to the session model without asking', () => {
    const view = sessionOn(SONNET, { active: { model: HAIKU, effort: 'low' }, recentTiers: [1] })
    expect(plan(view, assessed(4))).toEqual({
      kind: 'apply',
      tier: 4,
      level: { model: SONNET, effort: 'high' },
      note: 'back to a stronger model',
    })
  })

  test('a light request in the middle of heavy work waits before moving to Haiku', () => {
    const view = sessionOn(OPUS, { sessionEffort: 'high', recentTiers: [6] })
    expect(plan(view, assessed(2)).kind).toBe('stay')
    const decision = plan({ ...view, recentTiers: [6, 2] }, assessed(2))
    expect(decision.kind === 'apply' && decision.level.model).toBe(HAIKU)
  })

  test('a large context or a redo keeps light requests on the session model', () => {
    const large = plan(sessionOn(OPUS, { contextTokens: 150_000 }), assessed(1))
    expect(large.kind === 'apply' && large.level).toEqual({ model: OPUS, effort: 'low' })
    const redo = plan(sessionOn(OPUS, { lastRunTier: 1 }), assessed(1, { rework: true }))
    expect(redo.kind === 'apply' && redo.level.model).toBe(OPUS)
  })

  test('the first working request runs on the tier level even below the session model', () => {
    expect(plan(sessionOn(OPUS, { settled: false }), assessed(4))).toEqual({
      kind: 'apply',
      tier: 4,
      level: { model: SONNET, effort: 'high' },
      note: 'tier level for the session',
    })
  })

  test('work after a light request goes back to the model the session settled on', () => {
    const view = sessionOn(OPUS, { homeModel: SONNET, active: { model: HAIKU, effort: 'low' }, recentTiers: [1] })
    expect(plan(view, assessed(4))).toEqual({
      kind: 'apply',
      tier: 4,
      level: { model: SONNET, effort: 'high' },
      note: 'back to a stronger model',
    })
  })

  test('on a small context, lighter work moves to the tier model', () => {
    const decision = plan(sessionOn(OPUS, { sessionEffort: 'high' }), assessed(4))
    expect(decision.kind === 'apply' && decision.level).toEqual({ model: SONNET, effort: 'high' })
  })

  test('on a large context, lighter work keeps its model and lowers the effort', () => {
    const decision = plan(sessionOn(OPUS, { sessionEffort: 'high', contextTokens: 120_000 }), assessed(4))
    expect(decision.kind === 'apply' && decision.level).toEqual({ model: OPUS, effort: 'medium' })
  })

  test('a redo on a small context does not move to a lighter model', () => {
    const decision = plan(sessionOn(OPUS, { sessionEffort: 'low', lastRunTier: 3 }), assessed(3, { rework: true }))
    expect(decision.kind === 'apply' && decision.level.model).toBe(OPUS)
  })

  test('the first working request on a weaker model offers Opus for the session', () => {
    const decision = plan(sessionOn(HAIKU, { settled: false }), assessed(4))
    expect(decision.kind).toBe('ask')
    if (decision.kind === 'ask') {
      expect(decision.switchesModel).toBe(false)
      expect(decision.wider).toEqual({ model: OPUS, effort: 'medium' })
    }
  })
})

describe('freshStartReason', () => {
  const base = { contextTokens: 150_000, threshold: 120_000, newTopic: false, idleMs: 0 }

  test('a new topic over a large context', () => {
    expect(freshStartReason({ ...base, newTopic: true })).toBe('new-topic')
  })

  test('a return after the cache expired', () => {
    expect(freshStartReason({ ...base, idleMs: 61 * 60 * 1000 })).toBe('idle')
  })

  test('nothing below the threshold or when turned off', () => {
    expect(freshStartReason({ ...base, contextTokens: 50_000, newTopic: true })).toBe(null)
    expect(freshStartReason({ ...base, threshold: 0, newTopic: true })).toBe(null)
  })

  test('nothing while the same work goes on', () => {
    expect(freshStartReason(base)).toBe(null)
  })
})

describe('isConfirmation', () => {
  test('recognises a go-ahead in English and Italian', () => {
    for (const text of ['ok', 'sì, procedi', 'vai pure!', 'go ahead', 'perfetto grazie']) {
      expect(isConfirmation(text)).toBe(true)
    }
  })

  test('does not mistake a request for a go-ahead', () => {
    for (const text of ['ok ma cambia il colore', 'sì?', 'procedi con il deploy in produzione']) {
      expect(isConfirmation(text)).toBe(false)
    }
  })
})

describe('parseAssessment', () => {
  test('reads JSON wrapped in prose', () => {
    expect(parseAssessment('Sure: {"tier": 5, "reason": "new feature.", "newTopic": true, "rework": false}')).toEqual({
      tier: 5,
      reason: 'new feature',
      newTopic: true,
      rework: false,
    })
  })

  test('refuses a tier outside the scale and broken JSON', () => {
    expect(parseAssessment('{"tier": 9}')).toBe(null)
    expect(parseAssessment('{"tier": 3')).toBe(null)
  })
})

describe('tiers', () => {
  test('a weaker model cannot take a heavier tier', () => {
    expect(effortOn(SONNET, 5)).toBe(null)
    expect(effortOn(OPUS, 3)).toBe('low')
  })

  test('model names read the way /model shows them', () => {
    expect(displayName('claude-fable-5-2', 'high')).toBe('Fable 5.2 · high')
    expect(displayName('claude-opus-5-5-20261101')).toBe('Opus 5.5')
    expect(displayName('sonnet')).toBe('Sonnet')
  })
})

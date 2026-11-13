import type { AssessmentInput } from './assessor'
import { type TierId, isTier } from './tiers'

export type EvaluationCase = {
  line: number
  input: AssessmentInput
  expected: TierId
}

export type EvaluationResult = {
  expected: TierId
  assessed: TierId | null
}

export type EvaluationSummary = {
  cases: number
  answered: number
  exact: number
  withinOne: number
  under: number
  over: number
  meanError: number
}

const SEED_LIMIT = 200

/**
 * Reads labelled cases, one JSON object per line: `request` and the right `tier`, optionally
 * `previousReply`, `pendingQuestion`, `previousTier` and `kind`. Lines still unlabelled
 * (`tier` null) are skipped; malformed ones are reported by line number.
 */
export function parseCases(text: string, profile: string): { cases: EvaluationCase[]; invalid: number[] } {
  const cases: EvaluationCase[] = []
  const invalid: number[] = []
  text.split('\n').forEach((raw, index) => {
    if (!raw.trim()) {
      return
    }
    try {
      const row = JSON.parse(raw) as Record<string, unknown>
      if (row.tier === null) {
        return
      }
      const expected = Number(row.tier)
      if (typeof row.request !== 'string' || !row.request.trim() || !isTier(expected)) {
        invalid.push(index + 1)

        return
      }
      const previousTier = Number(row.previousTier)
      cases.push({
        line: index + 1,
        expected,
        input: {
          kind: row.kind === 'subagent' ? 'subagent' : 'request',
          request: row.request.trim(),
          previousReply: typeof row.previousReply === 'string' ? row.previousReply : '',
          pendingQuestion: typeof row.pendingQuestion === 'string' ? row.pendingQuestion : '',
          previousTier: isTier(previousTier) ? previousTier : null,
          profile,
        },
      })
    } catch {
      invalid.push(index + 1)
    }
  })

  return { cases, invalid }
}

export function summarize(results: readonly EvaluationResult[]): EvaluationSummary {
  const answered = results.filter((r): r is { expected: TierId; assessed: TierId } => r.assessed !== null)
  const errors = answered.map(r => r.assessed - r.expected)

  return {
    cases: results.length,
    answered: answered.length,
    exact: errors.filter(error => error === 0).length,
    withinOne: errors.filter(error => Math.abs(error) <= 1).length,
    under: errors.filter(error => error < 0).length,
    over: errors.filter(error => error > 0).length,
    meanError: errors.length ? errors.reduce((sum, error) => sum + error, 0) / errors.length : 0,
  }
}

/**
 * Turns journal lines into unlabelled cases: distinct typed requests, newest first, with `tier`
 * left null for a person to fill in. The tier the classifier gave is left out so it does not
 * steer the label.
 */
export function seedCases(journalText: string): string {
  const entries = journalText.split('\n').flatMap(line => {
    try {
      const parsed = JSON.parse(line) as { time?: unknown; kind?: unknown; text?: unknown; tier?: unknown } | null

      return parsed && typeof parsed === 'object' ? [parsed] : []
    } catch {
      return []
    }
  })
  const requests = entries
    .filter(entry => entry.kind === 'request' && entry.tier !== undefined && typeof entry.text === 'string' && entry.text.trim())
    .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
    .map(entry => String(entry.text).trim())
  const rows = [...new Set(requests)].slice(0, SEED_LIMIT).map(request => JSON.stringify({ request, tier: null }))

  return rows.length ? `${rows.join('\n')}\n` : ''
}

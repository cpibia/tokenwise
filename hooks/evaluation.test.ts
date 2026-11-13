import { describe, expect, test } from 'claude-code/testing'

import { parseCases, seedCases, summarize } from './evaluation'

describe('parseCases', () => {
  test('reads labelled lines, skips unlabelled ones and reports malformed ones', () => {
    const text = [
      '{"request": "commit and push", "tier": 3}',
      '{"request": "why does the queue stall?", "tier": null}',
      '{"request": "sì", "tier": 5, "previousReply": "Procedo con la migration?", "previousTier": 5}',
      '{"request": "", "tier": 2}',
      '{"request": "deploy", "tier": 9}',
      'not json',
    ].join('\n')

    const { cases, invalid } = parseCases(text, 'I build Laravel apps')

    expect(cases.map(c => [c.line, c.expected])).toEqual([
      [1, 3],
      [3, 5],
    ])
    expect(cases[1]!.input).toEqual({
      kind: 'request',
      request: 'sì',
      previousReply: 'Procedo con la migration?',
      pendingQuestion: '',
      previousTier: 5,
      profile: 'I build Laravel apps',
    })
    expect(invalid).toEqual([4, 5, 6])
  })
})

describe('summarize', () => {
  test('counts exact answers, near misses and the direction of the errors', () => {
    const summary = summarize([
      { expected: 4, assessed: 4 },
      { expected: 4, assessed: 5 },
      { expected: 2, assessed: 5 },
      { expected: 6, assessed: 5 },
      { expected: 3, assessed: null },
    ])

    expect(summary).toEqual({ cases: 5, answered: 4, exact: 1, withinOne: 3, under: 1, over: 2, meanError: 0.75 })
  })
})

describe('seedCases', () => {
  test('keeps distinct assessed requests, newest first, without the tier they got', () => {
    const journal = [
      '{"time": "2026-11-12T09:00:00Z", "kind": "request", "text": "commit and push", "tier": 3}',
      '{"time": "2026-11-12T09:05:00Z", "kind": "subagent", "text": "find controllers", "tier": 2}',
      '{"time": "2026-11-12T09:06:00Z", "kind": "request", "text": "~ quick one", "outcome": "skipped with ~"}',
      '{"time": "2026-11-13T10:00:00Z", "kind": "request", "text": "fix the login bug", "tier": 6}',
      '{"time": "2026-11-13T11:00:00Z", "kind": "request", "text": "commit and push", "tier": 4}',
      'null',
    ].join('\n')

    expect(seedCases(journal)).toBe('{"request":"commit and push","tier":null}\n{"request":"fix the login bug","tier":null}\n')
  })
})

test('/tokenwise eval measures the classifier on the labelled file and writes the cases', async ($, on) => {
  const files = new Map<string, string>([
    ['/home/test/.claude/tokenwise/eval.jsonl', '{"request": "commit and push", "tier": 3}\n{"request": "redesign the auth flow", "tier": 7}\n'],
  ])
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 13) }))
  on('config.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('model.complete', (_, e) => ({
    value: {
      isAnswered: true as const,
      text: e.prompt.includes('commit') ? '{"tier": 3, "reason": "mechanical"}' : '{"tier": 5, "reason": "feature"}',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))

  const result = await $.command.run({ command: 'tokenwise', args: 'eval', origin: { kind: 'composer' } } as never)

  expect(result.text).toContain('2 labelled requests: 1 exact (50%), 1 within one tier (50%)')
  expect(result.text).toContain('Below the label: 1. Above it: 0.')
  const report = files.get('/home/test/.claude/tokenwise/eval-2026-11-13T00-00-00-000Z.jsonl')
  expect(report?.trim().split('\n').map(line => (JSON.parse(line) as { assessed: number }).assessed)).toEqual([3, 5])
})
